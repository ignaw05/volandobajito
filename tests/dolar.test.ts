import { describe, expect, it } from "vitest";
import { createDolarClient } from "../src/clients/dolar.js";

function fetchStub(responses: (() => Response)[]): {
	fetchImpl: typeof fetch;
	calls: () => number;
} {
	let count = 0;
	const fetchImpl = (async () => {
		const make = responses[Math.min(count, responses.length - 1)];
		count += 1;
		return make ? make() : new Response("", { status: 500 });
	}) as typeof fetch;
	return { fetchImpl, calls: () => count };
}

const okResponse = () =>
	new Response(JSON.stringify({ compra: 1430, venta: 1500 }), { status: 200 });

describe("createDolarClient", () => {
	it("returns the venta rate and caches it for an hour", async () => {
		let nowMs = 0;
		const { fetchImpl, calls } = fetchStub([okResponse]);
		const client = createDolarClient({ fetchImpl, now: () => nowMs });

		expect(await client.getTarjetaRate()).toBe(1500);
		nowMs = 30 * 60_000; // 30 minutes later: still cached
		expect(await client.getTarjetaRate()).toBe(1500);
		expect(calls()).toBe(1);

		nowMs = 61 * 60_000; // past the TTL: refetches
		await client.getTarjetaRate();
		expect(calls()).toBe(2);
	});

	it("returns null on HTTP failure without caching it", async () => {
		const { fetchImpl, calls } = fetchStub([
			() => new Response("", { status: 503 }),
			okResponse,
		]);
		const client = createDolarClient({ fetchImpl });
		expect(await client.getTarjetaRate()).toBeNull();
		// The failure is not cached: the next call tries again and succeeds.
		expect(await client.getTarjetaRate()).toBe(1500);
		expect(calls()).toBe(2);
	});

	it("returns null on a malformed body", async () => {
		const { fetchImpl } = fetchStub([
			() => new Response(JSON.stringify({ venta: "no" }), { status: 200 }),
		]);
		const client = createDolarClient({ fetchImpl });
		expect(await client.getTarjetaRate()).toBeNull();
	});

	it("returns null when the request throws", async () => {
		const fetchImpl = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		const client = createDolarClient({ fetchImpl });
		expect(await client.getTarjetaRate()).toBeNull();
	});
});
