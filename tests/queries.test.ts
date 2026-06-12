import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
	createDb,
	INSERT_CHUNK_SIZE,
	type NewPriceObservation,
} from "../src/db/queries.js";

interface RecordedOp {
	method: string;
	args: unknown[];
}

interface RecordedCall {
	table: string;
	ops: RecordedOp[];
}

interface StubResult {
	data?: unknown;
	error?: { message: string } | null;
}

/**
 * Thin chainable stub of the supabase-js query builder. Each from() call
 * consumes the next result from the queue (last one repeats) and records
 * every method invoked on the chain.
 */
function createSupabaseStub(results: StubResult[] = [{ data: null }]) {
	const calls: RecordedCall[] = [];
	let next = 0;
	const client = {
		from(table: string) {
			const result = results[Math.min(next, results.length - 1)] ?? {};
			next += 1;
			const ops: RecordedOp[] = [];
			calls.push({ table, ops });
			const builder: Record<string, unknown> = {};
			for (const method of [
				"select",
				"insert",
				"upsert",
				"update",
				"eq",
				"order",
				"single",
			]) {
				builder[method] = (...args: unknown[]) => {
					ops.push({ method, args });
					return builder;
				};
			}
			builder.then = (
				resolve: (value: unknown) => unknown,
				reject: (reason: unknown) => unknown,
			) =>
				Promise.resolve({
					data: result.data ?? null,
					error: result.error ?? null,
				}).then(resolve, reject);
			return builder;
		},
	};
	return { client: client as unknown as SupabaseClient, calls };
}

function opsOf(call: RecordedCall): string[] {
	return call.ops.map((op) => op.method);
}

function findOp(call: RecordedCall, method: string): RecordedOp {
	const op = call.ops.find((o) => o.method === method);
	if (!op) throw new Error(`op ${method} not recorded`);
	return op;
}

const observation: NewPriceObservation = {
	route_id: 1,
	depart_date: "2026-08-15",
	return_date: null,
	price_usd: 350,
	airline: "AR",
	direct: true,
	source: "travelpayouts",
};

describe("getActiveRoutes", () => {
	it("queries routes filtered by active=true", async () => {
		const { client, calls } = createSupabaseStub([{ data: [{ id: 1 }] }]);
		const routes = await createDb(client).getActiveRoutes();
		expect(routes).toEqual([{ id: 1 }]);
		expect(calls[0]?.table).toBe("routes");
		expect(findOp(calls[0]!, "eq").args).toEqual(["active", true]);
	});

	it("throws a contextual error when the query fails", async () => {
		const { client } = createSupabaseStub([
			{ error: { message: "connection refused" } },
		]);
		await expect(createDb(client).getActiveRoutes()).rejects.toThrow(
			/getActiveRoutes: connection refused/,
		);
	});
});

describe("insertPriceObservations", () => {
	it("inserts rows into price_history", async () => {
		const { client, calls } = createSupabaseStub();
		const inserted = await createDb(client).insertPriceObservations([
			observation,
		]);
		expect(inserted).toBe(1);
		expect(calls[0]?.table).toBe("price_history");
		expect(findOp(calls[0]!, "insert").args[0]).toEqual([observation]);
	});

	it("chunks large batches", async () => {
		const { client, calls } = createSupabaseStub();
		const rows = Array.from({ length: INSERT_CHUNK_SIZE * 2 + 1 }, () => ({
			...observation,
		}));
		await createDb(client).insertPriceObservations(rows);
		expect(calls.length).toBe(3);
		expect((findOp(calls[0]!, "insert").args[0] as unknown[]).length).toBe(
			INSERT_CHUNK_SIZE,
		);
		expect((findOp(calls[2]!, "insert").args[0] as unknown[]).length).toBe(1);
	});
});

describe("upsertRouteStats", () => {
	it("upserts on route_id and stamps updated_at", async () => {
		const { client, calls } = createSupabaseStub();
		await createDb(client).upsertRouteStats([
			{
				route_id: 7,
				median_usd: 800,
				p10_usd: 500,
				p25_usd: 620,
				sample_count: 40,
				window_days: 90,
			},
		]);
		expect(calls[0]?.table).toBe("route_stats");
		const upsert = findOp(calls[0]!, "upsert");
		expect(upsert.args[1]).toEqual({ onConflict: "route_id" });
		const row = (upsert.args[0] as Record<string, unknown>[])[0]!;
		expect(row.route_id).toBe(7);
		expect(typeof row.updated_at).toBe("string");
	});
});

describe("createDeal / transitionDeal", () => {
	const newDeal = {
		route_id: 7,
		depart_date: "2026-09-01",
		return_date: "2026-09-15",
		cached_price_usd: 489,
		airline: "IB",
		direct: true,
		median_at_detection: 790,
		discount_pct: 0.38,
		score: 53,
		is_error_fare: false,
	};

	it("inserts a deal and returns the created row", async () => {
		const { client, calls } = createSupabaseStub([
			{ data: { id: "uuid-1", status: "candidate", ...newDeal } },
		]);
		const deal = await createDb(client).createDeal(newDeal);
		expect(deal.id).toBe("uuid-1");
		expect(calls[0]?.table).toBe("deals");
		expect(opsOf(calls[0]!)).toEqual(["insert", "select", "single"]);
	});

	it.each([
		["verified", "verified_at"],
		["published", "published_at"],
		["expired", "expired_at"],
	] as const)("stamps %s -> %s", async (status, column) => {
		const { client, calls } = createSupabaseStub([{ data: { id: "d1" } }]);
		await createDb(client).transitionDeal("d1", status);
		const update = findOp(calls[0]!, "update").args[0] as Record<
			string,
			unknown
		>;
		expect(update.status).toBe(status);
		expect(typeof update[column]).toBe("string");
	});

	it("does not stamp a timestamp for rejected, and applies the patch", async () => {
		const { client, calls } = createSupabaseStub([{ data: { id: "d1" } }]);
		await createDb(client).transitionDeal("d1", "rejected", {
			rejection_reason: "price_gone",
		});
		const update = findOp(calls[0]!, "update").args[0] as Record<
			string,
			unknown
		>;
		expect(update).toEqual({
			status: "rejected",
			rejection_reason: "price_gone",
		});
		expect(findOp(calls[0]!, "eq").args).toEqual(["id", "d1"]);
	});
});

describe("recordClick", () => {
	it("inserts the click event", async () => {
		const { client, calls } = createSupabaseStub();
		await createDb(client).recordClick({
			deal_id: "uuid-1",
			user_agent: "Mozilla/5.0",
			referer: null,
		});
		expect(calls[0]?.table).toBe("click_events");
		expect(findOp(calls[0]!, "insert").args[0]).toEqual({
			deal_id: "uuid-1",
			user_agent: "Mozilla/5.0",
			referer: null,
		});
	});
});
