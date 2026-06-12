import { pathToFileURL } from "node:url";
import {
	createTravelpayoutsClient,
	type TravelpayoutsClient,
} from "../clients/travelpayouts.js";
import { loadConfigSubset } from "../config.js";
import {
	createDb,
	createSupabase,
	type NewPriceObservation,
	type Route,
} from "../db/queries.js";

/** Months swept per route: current month plus the next three. */
export const MONTHS_PER_ROUTE = 4;

/** ["2026-06", "2026-07", ...] starting at `from`'s month. */
export function nextMonths(count: number, from: Date = new Date()): string[] {
	return Array.from({ length: count }, (_, i) => {
		const d = new Date(
			Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1),
		);
		const month = String(d.getUTCMonth() + 1).padStart(2, "0");
		return `${d.getUTCFullYear()}-${month}`;
	});
}

export interface ScanSummary {
	routesScanned: number;
	routesWithData: number;
	observationsInserted: number;
	errors: number;
	durationMs: number;
}

export interface ScanDeps {
	db: {
		getActiveRoutes(): Promise<Route[]>;
		insertPriceObservations(rows: NewPriceObservation[]): Promise<number>;
	};
	client: TravelpayoutsClient;
	monthsAhead?: number;
	now?: Date;
	log?: (line: string) => void;
}

/**
 * Layer 1 sweep: for every active route, fetch cached prices for the next
 * months and append them to price_history. Empty responses are expected
 * (rarely-searched routes have no cache) and are not errors. A failing
 * route never aborts the sweep.
 */
export async function runScan(deps: ScanDeps): Promise<ScanSummary> {
	const log = deps.log ?? console.log;
	const months = nextMonths(deps.monthsAhead ?? MONTHS_PER_ROUTE, deps.now);
	const startedAt = Date.now();
	const routes = await deps.db.getActiveRoutes();
	const summary: ScanSummary = {
		routesScanned: 0,
		routesWithData: 0,
		observationsInserted: 0,
		errors: 0,
		durationMs: 0,
	};

	for (const route of routes) {
		try {
			const rows: NewPriceObservation[] = [];
			for (const month of months) {
				const quotes = await deps.client.monthlyPrices(
					route.origin,
					route.destination,
					month,
				);
				for (const quote of quotes) {
					rows.push({ route_id: route.id, source: "travelpayouts", ...quote });
				}
			}
			if (rows.length > 0) {
				await deps.db.insertPriceObservations(rows);
				summary.observationsInserted += rows.length;
				summary.routesWithData += 1;
			}
			summary.routesScanned += 1;
		} catch (error) {
			summary.errors += 1;
			const reason = error instanceof Error ? error.message : String(error);
			log(`scan: route ${route.origin}-${route.destination} failed: ${reason}`);
		}
	}

	summary.durationMs = Date.now() - startedAt;
	log(
		`scan: ${summary.routesScanned}/${routes.length} routes swept, ` +
			`${summary.routesWithData} with data, ` +
			`${summary.observationsInserted} observations inserted, ` +
			`${summary.errors} errors, ${(summary.durationMs / 1000).toFixed(1)}s`,
	);
	return summary;
}

async function main(): Promise<void> {
	const config = loadConfigSubset(
		"SUPABASE_URL",
		"SUPABASE_SERVICE_ROLE_KEY",
		"TRAVELPAYOUTS_TOKEN",
	);
	const db = createDb(
		createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
	);
	const client = createTravelpayoutsClient(config.TRAVELPAYOUTS_TOKEN);
	const summary = await runScan({ db, client });
	// A sweep where nothing succeeded is an operational failure.
	if (summary.routesScanned === 0 && summary.errors > 0) {
		process.exit(1);
	}
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
