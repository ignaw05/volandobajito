import { describe, expect, it } from "vitest";
import type {
	NewDeal,
	PriceObservation,
	Route,
	RouteStats,
} from "../src/db/queries.js";
import {
	BREADTH_BONUS,
	buildCandidates,
	DIRECT_BONUS,
	evaluatePrice,
	REGION_WEIGHTS,
	runDetect,
} from "../src/pipeline/detect.js";

function route(id: number, overrides: Partial<Route> = {}): Route {
	return {
		id,
		origin: "EZE",
		destination: "MAD",
		region: "europe",
		active: true,
		sanity_threshold_usd: 650,
		created_at: "2026-06-01T00:00:00Z",
		...overrides,
	};
}

function stats(
	routeId: number,
	overrides: Partial<RouteStats> = {},
): RouteStats {
	return {
		route_id: routeId,
		median_usd: 1000,
		p10_usd: 750,
		p25_usd: 850,
		sample_count: 40,
		window_days: 90,
		...overrides,
	};
}

let observationId = 0;
function observation(
	routeId: number,
	priceUsd: number,
	overrides: Partial<PriceObservation> = {},
): PriceObservation {
	observationId += 1;
	return {
		id: observationId,
		route_id: routeId,
		depart_date: "2026-09-10",
		return_date: "2026-09-24",
		price_usd: priceUsd,
		airline: "IB",
		direct: false,
		source: "travelpayouts",
		observed_at: "2026-06-12T10:00:00Z",
		...overrides,
	};
}

describe("evaluatePrice", () => {
	// Thresholds for the default stats: p10=750, 0.7*median=700, 0.5*median=500.
	const r = route(1, { sanity_threshold_usd: null });

	it("normal price is not a candidate", () => {
		expect(evaluatePrice(900, r, stats(1))).toEqual({
			isCandidate: false,
			isErrorFare: false,
		});
	});

	it("price under p10 but not under 70% of median is not a candidate", () => {
		expect(evaluatePrice(720, r, stats(1)).isCandidate).toBe(false);
	});

	it("statistical bargain is a candidate", () => {
		expect(evaluatePrice(650, r, stats(1))).toEqual({
			isCandidate: true,
			isErrorFare: false,
		});
	});

	it("price under 50% of median is an error fare", () => {
		expect(evaluatePrice(450, r, stats(1))).toEqual({
			isCandidate: true,
			isErrorFare: true,
		});
	});

	it("insufficient sample is never a statistical candidate, even dirt cheap", () => {
		expect(
			evaluatePrice(100, r, stats(1, { sample_count: 10 })).isCandidate,
		).toBe(false);
		expect(evaluatePrice(100, r, undefined).isCandidate).toBe(false);
	});

	it("absolute sanity threshold qualifies regardless of statistics", () => {
		const withThreshold = route(1, { sanity_threshold_usd: 650 });
		expect(
			evaluatePrice(600, withThreshold, stats(1, { sample_count: 3 }))
				.isCandidate,
		).toBe(true);
		expect(evaluatePrice(600, withThreshold, undefined).isCandidate).toBe(true);
	});

	it("error fare flag still requires usable statistics", () => {
		const withThreshold = route(1, { sanity_threshold_usd: 650 });
		expect(
			evaluatePrice(100, withThreshold, stats(1, { sample_count: 3 })),
		).toEqual({ isCandidate: true, isErrorFare: false });
	});
});

describe("buildCandidates", () => {
	const routesById = new Map([[1, route(1)]]);
	const statsById = new Map([[1, stats(1)]]);

	it("creates one deal per route using the cheapest qualifying observation", () => {
		const { deals } = buildCandidates(
			[observation(1, 650), observation(1, 600), observation(1, 900)],
			routesById,
			statsById,
			new Set(),
		);
		expect(deals.length).toBe(1);
		expect(deals[0]?.cached_price_usd).toBe(600);
		expect(deals[0]?.median_at_detection).toBe(1000);
		expect(deals[0]?.discount_pct).toBeCloseTo(0.4);
	});

	it("scores discount + direct + region weight", () => {
		const { deals } = buildCandidates(
			[observation(1, 600, { direct: true })],
			routesById,
			statsById,
			new Set(),
		);
		// 40% discount -> 40, direct -> 10, europe -> 15.
		expect(deals[0]?.score).toBeCloseTo(
			40 + DIRECT_BONUS + REGION_WEIGHTS.europe,
		);
	});

	it("adds the breadth bonus with >= 5 distinct cheap dates", () => {
		const dates = [
			"2026-09-01",
			"2026-09-03",
			"2026-09-08",
			"2026-09-15",
			"2026-09-22",
		];
		const { deals } = buildCandidates(
			dates.map((depart_date) => observation(1, 600, { depart_date })),
			routesById,
			statsById,
			new Set(),
		);
		expect(deals[0]?.score).toBeCloseTo(
			40 + REGION_WEIGHTS.europe + BREADTH_BONUS,
		);
	});

	it("skips routes in cooldown", () => {
		const { deals, skippedCooldown } = buildCandidates(
			[observation(1, 600)],
			routesById,
			statsById,
			new Set([1]),
		);
		expect(deals).toEqual([]);
		expect(skippedCooldown).toBe(1);
	});

	it("marks the deal as error fare when the best price qualifies", () => {
		const { deals } = buildCandidates(
			[observation(1, 450)],
			routesById,
			statsById,
			new Set(),
		);
		expect(deals[0]?.is_error_fare).toBe(true);
	});

	it("sanity-threshold candidate without stats has null discount and base score", () => {
		const bare = new Map([
			[2, route(2, { region: "regional", sanity_threshold_usd: 120 })],
		]);
		const { deals } = buildCandidates(
			[observation(2, 90)],
			bare,
			new Map(),
			new Set(),
		);
		expect(deals[0]?.discount_pct).toBeNull();
		expect(deals[0]?.median_at_detection).toBeNull();
		expect(deals[0]?.score).toBeCloseTo(REGION_WEIGHTS.regional);
	});
});

describe("runDetect", () => {
	function harness(observations: PriceObservation[], blocked: number[] = []) {
		const created: NewDeal[][] = [];
		const logs: string[] = [];
		const deps = {
			db: {
				refreshRouteStats: async () => 480,
				listRouteStats: async () => [stats(1)],
				getActiveRoutes: async () => [route(1)],
				getRecentObservations: async () => observations,
				getRoutesWithDealsSince: async () => blocked,
				createDeals: async (deals: NewDeal[]) => {
					created.push(deals);
					return deals.length;
				},
			},
			now: new Date("2026-06-12T12:00:00Z"),
			log: (line: string) => logs.push(line),
		};
		return { deps, created, logs };
	}

	it("wires refresh, evaluation and insertion together", async () => {
		const { deps, created } = harness([observation(1, 600)]);
		const summary = await runDetect(deps);
		expect(summary.routesRefreshed).toBe(480);
		expect(summary.observationsEvaluated).toBe(1);
		expect(summary.candidatesCreated).toBe(1);
		expect(created[0]?.[0]?.route_id).toBe(1);
	});

	it("counts cooldown skips and creates nothing", async () => {
		const { deps, created } = harness([observation(1, 600)], [1]);
		const summary = await runDetect(deps);
		expect(summary.candidatesCreated).toBe(0);
		expect(summary.skippedCooldown).toBe(1);
		expect(created.flat()).toEqual([]);
	});

	it("warns when a run produces more than 50 candidates", async () => {
		const manyRoutes = Array.from({ length: 60 }, (_, i) => route(i + 1));
		const { deps, logs } = harness([]);
		deps.db.getActiveRoutes = async () => manyRoutes;
		deps.db.listRouteStats = async () => manyRoutes.map((r) => stats(r.id));
		deps.db.getRecentObservations = async () =>
			manyRoutes.map((r) => observation(r.id, 600));
		const summary = await runDetect(deps);
		expect(summary.candidatesCreated).toBe(60);
		expect(logs.some((line) => line.includes("WARNING"))).toBe(true);
	});
});
