import { loadConfigSubset } from "../src/config.js";
import {
	createDb,
	createSupabase,
	type NewPriceObservation,
} from "../src/db/queries.js";

/**
 * Optional cold-start mitigation: for the main routes, fetch Google Flights
 * price insights via SerpApi and store the typical price range as synthetic
 * observations (source 'serpapi_bootstrap'). Skips silently when
 * SERPAPI_KEY is not configured.
 */

const SERPAPI_URL = "https://serpapi.com/search.json";
const ROUTE_LIMIT = 60;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;
// A plausible round trip well in the future, so insights reflect normal fares.
const OUTBOUND_DAYS_AHEAD = 45;
const TRIP_LENGTH_DAYS = 14;

function isoDatePlusDays(days: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

async function fetchPriceRange(
	apiKey: string,
	origin: string,
	destination: string,
	outboundDate: string,
	returnDate: string,
): Promise<[number, number] | null> {
	const params = new URLSearchParams({
		engine: "google_flights",
		departure_id: origin,
		arrival_id: destination,
		outbound_date: outboundDate,
		return_date: returnDate,
		currency: "USD",
		api_key: apiKey,
	});
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(`${SERPAPI_URL}?${params}`, {
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as {
				price_insights?: { typical_price_range?: unknown };
			};
			const range = body.price_insights?.typical_price_range;
			if (
				Array.isArray(range) &&
				range.length === 2 &&
				typeof range[0] === "number" &&
				typeof range[1] === "number"
			) {
				return [range[0], range[1]];
			}
			return null;
		} catch (error) {
			if (attempt >= MAX_RETRIES) throw error;
			await new Promise((resolve) =>
				setTimeout(resolve, BACKOFF_BASE_MS * 2 ** attempt),
			);
		}
	}
}

async function main(): Promise<void> {
	const config = loadConfigSubset(
		"SUPABASE_URL",
		"SUPABASE_SERVICE_ROLE_KEY",
		"SERPAPI_KEY",
	);
	if (!config.SERPAPI_KEY) {
		console.log("bootstrap-baseline: SERPAPI_KEY not set, skipping");
		return;
	}
	const apiKey = config.SERPAPI_KEY;

	const db = createDb(
		createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
	);
	// "Main routes" = EZE (primary international airport) routes, seed order.
	const routes = (await db.getActiveRoutes())
		.filter((route) => route.origin === "EZE")
		.slice(0, ROUTE_LIMIT);

	const outboundDate = isoDatePlusDays(OUTBOUND_DAYS_AHEAD);
	const returnDate = isoDatePlusDays(OUTBOUND_DAYS_AHEAD + TRIP_LENGTH_DAYS);
	let inserted = 0;
	let withoutInsights = 0;
	let errors = 0;

	for (const route of routes) {
		try {
			const range = await fetchPriceRange(
				apiKey,
				route.origin,
				route.destination,
				outboundDate,
				returnDate,
			);
			if (!range) {
				withoutInsights += 1;
				continue;
			}
			const rows: NewPriceObservation[] = range.map((price) => ({
				route_id: route.id,
				depart_date: outboundDate,
				return_date: returnDate,
				price_usd: price,
				airline: null,
				direct: null,
				source: "serpapi_bootstrap",
			}));
			inserted += await db.insertPriceObservations(rows);
		} catch (error) {
			errors += 1;
			const reason = error instanceof Error ? error.message : String(error);
			console.log(
				`bootstrap-baseline: ${route.origin}-${route.destination} failed: ${reason}`,
			);
		}
	}

	console.log(
		`bootstrap-baseline: ${routes.length} routes, ${inserted} observations inserted, ` +
			`${withoutInsights} without price insights, ${errors} errors`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
