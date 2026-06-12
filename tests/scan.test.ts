import { describe, expect, it } from "vitest";
import type { PriceQuote } from "../src/clients/travelpayouts.js";
import type { NewPriceObservation, Route } from "../src/db/queries.js";
import { nextMonths, runScan } from "../src/pipeline/scan.js";

function route(id: number, origin: string, destination: string): Route {
	return {
		id,
		origin,
		destination,
		region: "europe",
		active: true,
		sanity_threshold_usd: 650,
		created_at: "2026-06-01T00:00:00Z",
	};
}

const quote: PriceQuote = {
	depart_date: "2026-07-12",
	return_date: "2026-07-28",
	price_usd: 689,
	airline: "IB",
	direct: true,
};

interface StubBehavior {
	[routeKey: string]: PriceQuote[] | Error;
}

function scanHarness(routes: Route[], behavior: StubBehavior) {
	const inserted: NewPriceObservation[][] = [];
	const requestedMonths: string[] = [];
	const logs: string[] = [];
	const deps = {
		db: {
			getActiveRoutes: async () => routes,
			insertPriceObservations: async (rows: NewPriceObservation[]) => {
				inserted.push(rows);
				return rows.length;
			},
		},
		client: {
			monthlyPrices: async (
				origin: string,
				destination: string,
				month: string,
			) => {
				requestedMonths.push(`${origin}-${destination}:${month}`);
				const result = behavior[`${origin}-${destination}`] ?? [];
				if (result instanceof Error) throw result;
				return result;
			},
		},
		now: new Date("2026-06-12T12:00:00Z"),
		log: (line: string) => logs.push(line),
	};
	return { deps, inserted, requestedMonths, logs };
}

describe("nextMonths", () => {
	it("starts at the current month", () => {
		expect(nextMonths(4, new Date("2026-06-12T12:00:00Z"))).toEqual([
			"2026-06",
			"2026-07",
			"2026-08",
			"2026-09",
		]);
	});

	it("rolls over the year boundary", () => {
		expect(nextMonths(4, new Date("2026-11-03T00:00:00Z"))).toEqual([
			"2026-11",
			"2026-12",
			"2027-01",
			"2027-02",
		]);
	});
});

describe("runScan", () => {
	it("sweeps each route across 4 months and inserts tagged observations", async () => {
		const { deps, inserted, requestedMonths } = scanHarness(
			[route(1, "EZE", "MAD")],
			{ "EZE-MAD": [quote] },
		);
		const summary = await runScan(deps);

		expect(requestedMonths).toEqual([
			"EZE-MAD:2026-06",
			"EZE-MAD:2026-07",
			"EZE-MAD:2026-08",
			"EZE-MAD:2026-09",
		]);
		// One quote per month, inserted in a single batch per route.
		expect(inserted.length).toBe(1);
		expect(inserted[0]!.length).toBe(4);
		expect(inserted[0]![0]).toEqual({
			route_id: 1,
			source: "travelpayouts",
			...quote,
		});
		expect(summary.routesScanned).toBe(1);
		expect(summary.routesWithData).toBe(1);
		expect(summary.observationsInserted).toBe(4);
		expect(summary.errors).toBe(0);
	});

	it("treats empty responses as a normal sweep, without inserting", async () => {
		const { deps, inserted } = scanHarness([route(2, "ROS", "AKL")], {
			"ROS-AKL": [],
		});
		const summary = await runScan(deps);
		expect(inserted.length).toBe(0);
		expect(summary.routesScanned).toBe(1);
		expect(summary.routesWithData).toBe(0);
		expect(summary.errors).toBe(0);
	});

	it("isolates a failing route: the sweep continues and the error is logged", async () => {
		const { deps, inserted, logs } = scanHarness(
			[route(1, "EZE", "MAD"), route(2, "EZE", "GRU"), route(3, "AEP", "SCL")],
			{
				"EZE-MAD": [quote],
				"EZE-GRU": new Error("travelpayouts: HTTP 500 after 3 retries"),
				"AEP-SCL": [quote],
			},
		);
		const summary = await runScan(deps);
		expect(summary.routesScanned).toBe(2);
		expect(summary.errors).toBe(1);
		expect(inserted.length).toBe(2);
		expect(logs.some((line) => line.includes("EZE-GRU failed"))).toBe(true);
	});
});
