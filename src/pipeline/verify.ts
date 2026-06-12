import { pathToFileURL } from "node:url";
import {
	createVerifier,
	type FlightVerifier,
	googleFlightsUrl,
} from "../clients/flightVerifier.js";
import { loadConfigSubset } from "../config.js";
import {
	type CandidateWithRoute,
	createDb,
	createSupabase,
	type Deal,
	type DealPatch,
	type DealStatus,
} from "../db/queries.js";

/**
 * The layer-1 cache is always somewhat stale; a live price up to 15%
 * above the cached one still confirms the deal.
 */
export const PRICE_TOLERANCE = 1.15;

export interface VerifySummary {
	processed: number;
	confirmed: number;
	rejected: number;
	errors: number;
	/** Paid provider calls actually spent this run. */
	paidCalls: number;
	budget: number;
	durationMs: number;
}

export interface VerifyDeps {
	db: {
		getTopCandidates(limit: number): Promise<CandidateWithRoute[]>;
		transitionDeal(
			id: string,
			status: DealStatus,
			patch?: DealPatch,
		): Promise<Deal>;
	};
	verifier: FlightVerifier;
	/** Hard cap of paid calls for this run (MAX_VERIFICATIONS_PER_RUN). */
	budget: number;
	log?: (line: string) => void;
}

/**
 * Layer 3: re-checks the top candidates against a live-price provider.
 * Confirmed deals move to `verified`; vanished prices to `rejected`.
 * A provider error leaves the deal as `candidate` so a later run can
 * retry it — and never counts as a rejection.
 */
export async function runVerify(deps: VerifyDeps): Promise<VerifySummary> {
	const log = deps.log ?? console.log;
	const startedAt = Date.now();
	const summary: VerifySummary = {
		processed: 0,
		confirmed: 0,
		rejected: 0,
		errors: 0,
		paidCalls: 0,
		budget: deps.budget,
		durationMs: 0,
	};

	const candidates = await deps.db.getTopCandidates(deps.budget);
	for (const candidate of candidates) {
		const { origin, destination } = candidate.routes;
		const label = `${origin}-${destination} ${candidate.depart_date}`;
		summary.processed += 1;
		try {
			summary.paidCalls += 1;
			const result = await deps.verifier.verify(
				origin,
				destination,
				candidate.depart_date,
				candidate.return_date ?? undefined,
			);

			const livePriceUsd = result.alive ? result.priceUsd : undefined;
			const confirmed =
				livePriceUsd !== undefined &&
				livePriceUsd <= candidate.cached_price_usd * PRICE_TOLERANCE;

			if (confirmed) {
				const patch: DealPatch = {
					verified_price_usd: livePriceUsd,
					booking_url:
						result.bookingUrl ??
						googleFlightsUrl(origin, destination, candidate.depart_date),
				};
				if (result.airline !== undefined) patch.airline = result.airline;
				if (result.direct !== undefined) patch.direct = result.direct;
				await deps.db.transitionDeal(candidate.id, "verified", patch);
				summary.confirmed += 1;
				log(
					`verify: CONFIRMED ${label} cached=$${candidate.cached_price_usd} live=$${result.priceUsd}`,
				);
			} else {
				await deps.db.transitionDeal(candidate.id, "rejected", {
					rejection_reason: "price_gone",
				});
				summary.rejected += 1;
				const live =
					result.priceUsd === undefined ? "none" : `$${result.priceUsd}`;
				log(
					`verify: price gone ${label} cached=$${candidate.cached_price_usd} live=${live}`,
				);
			}
		} catch (error) {
			// Provider failure: leave as candidate for a future retry.
			summary.errors += 1;
			const reason = error instanceof Error ? error.message : String(error);
			log(`verify: ERROR ${label} left as candidate: ${reason}`);
		}
	}

	summary.durationMs = Date.now() - startedAt;
	if (summary.errors > 0 && summary.confirmed === 0 && summary.rejected === 0) {
		log(
			"verify: ERROR provider failing on every call — nothing verified, nothing will be published",
		);
	}
	log(
		`verify: ${summary.processed} processed, ${summary.confirmed} confirmed, ` +
			`${summary.rejected} rejected, ${summary.errors} errors, ` +
			`paid calls ${summary.paidCalls}/${summary.budget}, ` +
			`${(summary.durationMs / 1000).toFixed(1)}s`,
	);
	return summary;
}

async function main(): Promise<void> {
	const config = loadConfigSubset(
		"SUPABASE_URL",
		"SUPABASE_SERVICE_ROLE_KEY",
		"VERIFIER_PROVIDER",
		"SEARCHAPI_KEY",
		"FLIGHTAPI_KEY",
		"MAX_VERIFICATIONS_PER_RUN",
	);
	const db = createDb(
		createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
	);
	const verifier = createVerifier(config.VERIFIER_PROVIDER, {
		...(config.SEARCHAPI_KEY ? { searchApiKey: config.SEARCHAPI_KEY } : {}),
		...(config.FLIGHTAPI_KEY ? { flightApiKey: config.FLIGHTAPI_KEY } : {}),
	});
	const summary = await runVerify({
		db,
		verifier,
		budget: config.MAX_VERIFICATIONS_PER_RUN,
	});
	if (summary.errors > 0 && summary.confirmed === 0 && summary.rejected === 0) {
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
