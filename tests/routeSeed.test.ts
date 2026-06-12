import { describe, expect, it } from "vitest";
import {
	expandRoutes,
	ORIGINS,
	REGION_THRESHOLDS_USD,
	seedRoutesSql,
} from "../src/db/routeSeed.js";

describe("expandRoutes", () => {
	const routes = expandRoutes();

	it("produces between 400 and 500 routes", () => {
		expect(routes.length).toBeGreaterThanOrEqual(400);
		expect(routes.length).toBeLessThanOrEqual(500);
	});

	it("has no duplicate origin-destination pairs", () => {
		const pairs = new Set(routes.map((r) => `${r.origin}-${r.destination}`));
		expect(pairs.size).toBe(routes.length);
	});

	it("covers every origin with the same destination set", () => {
		for (const origin of ORIGINS) {
			const count = routes.filter((r) => r.origin === origin).length;
			expect(count).toBe(routes.length / ORIGINS.length);
		}
	});

	it("assigns the sanity threshold matching each region", () => {
		for (const route of routes) {
			expect(route.sanity_threshold_usd).toBe(
				REGION_THRESHOLDS_USD[route.region],
			);
		}
	});

	it("uses three-letter IATA codes only", () => {
		for (const route of routes) {
			expect(route.origin).toMatch(/^[A-Z]{3}$/);
			expect(route.destination).toMatch(/^[A-Z]{3}$/);
		}
	});

	it("includes the minimum destination list from the plan", () => {
		const destinations = new Set(routes.map((r) => r.destination));
		const planMinimum = [
			"GRU",
			"GIG",
			"FLN",
			"SSA",
			"REC",
			"SCL",
			"MVD",
			"PDP",
			"ASU",
			"LIM",
			"BOG",
			"CUN",
			"PUJ",
			"HAV",
			"MIA",
			"MCO",
			"JFK",
			"LAX",
			"MAD",
			"BCN",
			"FCO",
			"MXP",
			"CDG",
			"LIS",
			"AMS",
			"LHR",
			"TLV",
			"AKL",
		];
		for (const code of planMinimum) {
			expect(destinations.has(code), `missing destination ${code}`).toBe(true);
		}
	});
});

describe("seedRoutesSql", () => {
	const sql = seedRoutesSql();

	it("is idempotent via on conflict do nothing", () => {
		expect(sql).toContain("on conflict (origin, destination) do nothing");
	});

	it("contains the origins and a known destination row", () => {
		expect(sql).toContain("('EZE'), ('AEP'), ('COR'), ('MDZ'), ('ROS')");
		expect(sql).toContain("('MAD', 'europe', 650)");
		expect(sql).toContain("('TLV', 'other', null)");
	});
});
