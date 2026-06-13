import { describe, expect, it } from "vitest";
import { createFliVerifier } from "../src/clients/fliVerifier.js";

/**
 * Builds a fake fli-js SearchFlights. `results` is returned verbatim by
 * `search`; `buildFlightBookingUrl` returns a fixed deep link. The last call's
 * options are captured so tests can assert the round-trip `topN`.
 */
function fakeSearch(results: unknown) {
	const calls: { options: unknown }[] = [];
	const search = {
		async search(_filters: unknown, options: unknown) {
			calls.push({ options });
			return results;
		},
		buildFlightBookingUrl() {
			return "https://www.google.com/travel/flights/booking?tfs=DEEP";
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
	} as any;
	return { search, calls };
}

function leg(airline: string) {
	return { airline };
}

describe("createFliVerifier", () => {
	it("maps the cheapest priced one-way itinerary", async () => {
		const { search } = fakeSearch([
			{ legs: [leg("AA")], price: 600, stops: 1 },
			{ legs: [leg("LA")], price: 500, stops: 0 },
		]);
		const verifier = createFliVerifier({ search });

		const result = await verifier.verify("EZE", "MAD", "2026-07-01");
		expect(result).toEqual({
			alive: true,
			priceUsd: 500,
			airline: "LA",
			direct: true,
			bookingUrl: "https://www.google.com/travel/flights/booking?tfs=DEEP",
		});
	});

	it("reports the fare gone when nothing is priced", async () => {
		const { search } = fakeSearch([
			{ legs: [leg("AA")], price: null, stops: 0 },
		]);
		const verifier = createFliVerifier({ search });
		expect(await verifier.verify("EZE", "MAD", "2026-07-01")).toEqual({
			alive: false,
		});
	});

	it("reads the round-trip total from the return leg and caps expansion", async () => {
		// A round-trip combo: [outbound, return]; the return carries the total.
		const { search, calls } = fakeSearch([
			[
				{ legs: [leg("IB")], price: 1200, stops: 0 },
				{ legs: [leg("IB")], price: 1100, stops: 0 },
			],
		]);
		const verifier = createFliVerifier({ search });

		const result = await verifier.verify(
			"EZE",
			"MAD",
			"2026-07-01",
			"2026-07-15",
		);
		expect(result.alive).toBe(true);
		expect(result.priceUsd).toBe(1100);
		expect((calls[0]?.options as { topN?: number }).topN).toBe(1);
	});

	it("throws on a provider failure so the caller can fall back", async () => {
		const verifier = createFliVerifier({
			search: {
				async search() {
					throw new Error("network down");
				},
				buildFlightBookingUrl: () => "",
				// biome-ignore lint/suspicious/noExplicitAny: minimal test double
			} as any,
		});
		await expect(verifier.verify("EZE", "MAD", "2026-07-01")).rejects.toThrow(
			/network down/,
		);
	});

	it("throws on an unknown airport code", async () => {
		const { search } = fakeSearch([]);
		const verifier = createFliVerifier({ search });
		await expect(verifier.verify("ZZZ", "MAD", "2026-07-01")).rejects.toThrow(
			/unknown airport/,
		);
	});
});
