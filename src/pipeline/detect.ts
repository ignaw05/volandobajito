import { pathToFileURL } from "node:url";
import { loadConfigSubset } from "../config.js";
import {
	createDb,
	createSupabase,
	type NewDeal,
	type PriceObservation,
	type Region,
	type Route,
	type RouteStats,
} from "../db/queries.js";

/** Below this many observations the statistics are not trustworthy. */
export const MIN_SAMPLE_COUNT = 25;
/** Statistical bargain: price < p10 AND price < 70% of the median. */
export const MEDIAN_DISCOUNT_FACTOR = 0.7;
/** Error fare: price < 50% of the median. */
export const ERROR_FARE_FACTOR = 0.5;
/** No new deal for a route with a non-rejected deal in this window. */
export const COOLDOWN_HOURS = 72;
/** Observations newer than this count as "the latest scan run". */
export const LOOKBACK_HOURS = 12;
/** More candidates than this in one run means thresholds are too loose. */
export const CANDIDATE_WARNING_THRESHOLD = 50;

export const DIRECT_BONUS = 10;
export const BREADTH_MIN_DATES = 5;
export const BREADTH_BONUS = 10;
export const REGION_WEIGHTS: Record<Region, number> = {
	europe: 15,
	usa: 12,
	caribbean: 10,
	regional: 5,
	other: 0,
};

export interface Verdict {
	isCandidate: boolean;
	isErrorFare: boolean;
}

/**
 * Candidate rule from the plan: with a sufficient sample, price < p10 AND
 * price < 70% of median; or, regardless of statistics, price below the
 * route's absolute sanity threshold.
 */
export function evaluatePrice(
	priceUsd: number,
	route: Route,
	stats: RouteStats | undefined,
): Verdict {
	const usableStats =
		stats !== undefined &&
		stats.sample_count >= MIN_SAMPLE_COUNT &&
		stats.median_usd !== null &&
		stats.p10_usd !== null;
	const statistical =
		usableStats &&
		priceUsd < (stats.p10_usd as number) &&
		priceUsd < MEDIAN_DISCOUNT_FACTOR * (stats.median_usd as number);
	const absolute =
		route.sanity_threshold_usd !== null &&
		priceUsd < route.sanity_threshold_usd;
	const isErrorFare =
		usableStats && priceUsd < ERROR_FARE_FACTOR * (stats.median_usd as number);
	return { isCandidate: statistical || absolute, isErrorFare };
}

export interface BuildResult {
	deals: NewDeal[];
	skippedCooldown: number;
}

/**
 * Turns one run's qualifying observations into deals: one per route (its
 * cheapest qualifying observation), scored for curation ordering, skipping
 * routes still in cooldown.
 */
export function buildCandidates(
	observations: PriceObservation[],
	routesById: Map<number, Route>,
	statsByRouteId: Map<number, RouteStats>,
	blockedRouteIds: Set<number>,
): BuildResult {
	const qualifyingByRoute = new Map<
		number,
		{ observation: PriceObservation; isErrorFare: boolean }[]
	>();
	for (const observation of observations) {
		const route = routesById.get(observation.route_id);
		if (!route) continue;
		const verdict = evaluatePrice(
			observation.price_usd,
			route,
			statsByRouteId.get(observation.route_id),
		);
		if (!verdict.isCandidate) continue;
		const list = qualifyingByRoute.get(observation.route_id) ?? [];
		list.push({ observation, isErrorFare: verdict.isErrorFare });
		qualifyingByRoute.set(observation.route_id, list);
	}

	const deals: NewDeal[] = [];
	let skippedCooldown = 0;
	for (const [routeId, qualifying] of qualifyingByRoute) {
		if (blockedRouteIds.has(routeId)) {
			skippedCooldown += 1;
			continue;
		}
		// biome-ignore lint/style/noNonNullAssertion: key comes from routesById lookups above
		const route = routesById.get(routeId)!;
		const stats = statsByRouteId.get(routeId);
		const best = qualifying.reduce((a, b) =>
			b.observation.price_usd < a.observation.price_usd ? b : a,
		);
		const distinctDates = new Set(
			qualifying.map((q) => q.observation.depart_date),
		).size;

		const median = stats?.median_usd ?? null;
		const discountPct =
			median !== null && median > 0
				? 1 - best.observation.price_usd / median
				: null;
		const score =
			(discountPct ?? 0) * 100 +
			(best.observation.direct ? DIRECT_BONUS : 0) +
			REGION_WEIGHTS[route.region] +
			(distinctDates >= BREADTH_MIN_DATES ? BREADTH_BONUS : 0);

		deals.push({
			route_id: routeId,
			depart_date: best.observation.depart_date,
			return_date: best.observation.return_date,
			cached_price_usd: best.observation.price_usd,
			airline: best.observation.airline,
			direct: best.observation.direct,
			median_at_detection: median,
			discount_pct: discountPct,
			score,
			is_error_fare: best.isErrorFare,
		});
	}
	return { deals, skippedCooldown };
}

export interface DetectSummary {
	routesRefreshed: number;
	observationsEvaluated: number;
	candidatesCreated: number;
	skippedCooldown: number;
	durationMs: number;
}

export interface DetectDeps {
	db: {
		refreshRouteStats(windowDays?: number): Promise<number>;
		listRouteStats(): Promise<RouteStats[]>;
		getActiveRoutes(): Promise<Route[]>;
		getRecentObservations(sinceIso: string): Promise<PriceObservation[]>;
		getRoutesWithDealsSince(sinceIso: string): Promise<number[]>;
		createDeals(deals: NewDeal[]): Promise<number>;
	};
	now?: Date;
	log?: (line: string) => void;
}

/** Layer 2: refresh stats, evaluate the latest sweep, insert candidates. */
export async function runDetect(deps: DetectDeps): Promise<DetectSummary> {
	const log = deps.log ?? console.log;
	const now = deps.now ?? new Date();
	const startedAt = Date.now();

	const routesRefreshed = await deps.db.refreshRouteStats();

	const [routes, stats, observations, blockedRouteIds] = await Promise.all([
		deps.db.getActiveRoutes(),
		deps.db.listRouteStats(),
		deps.db.getRecentObservations(
			new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000).toISOString(),
		),
		deps.db.getRoutesWithDealsSince(
			new Date(now.getTime() - COOLDOWN_HOURS * 3_600_000).toISOString(),
		),
	]);

	const routesById = new Map(routes.map((route) => [route.id, route]));
	const statsByRouteId = new Map(stats.map((s) => [s.route_id, s]));
	const { deals, skippedCooldown } = buildCandidates(
		observations,
		routesById,
		statsByRouteId,
		new Set(blockedRouteIds),
	);
	const candidatesCreated = await deps.db.createDeals(deals);

	if (candidatesCreated > CANDIDATE_WARNING_THRESHOLD) {
		log(
			`detect: WARNING ${candidatesCreated} candidates in one run ` +
				`(> ${CANDIDATE_WARNING_THRESHOLD}) — thresholds look loose`,
		);
	}

	const summary: DetectSummary = {
		routesRefreshed,
		observationsEvaluated: observations.length,
		candidatesCreated,
		skippedCooldown,
		durationMs: Date.now() - startedAt,
	};
	log(
		`detect: ${summary.routesRefreshed} routes refreshed, ` +
			`${summary.observationsEvaluated} observations evaluated, ` +
			`${summary.candidatesCreated} candidates created, ` +
			`${summary.skippedCooldown} skipped by cooldown, ` +
			`${(summary.durationMs / 1000).toFixed(1)}s`,
	);
	return summary;
}

async function main(): Promise<void> {
	const config = loadConfigSubset("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
	const db = createDb(
		createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
	);
	await runDetect({ db });
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
