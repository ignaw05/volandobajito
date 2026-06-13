import { pathToFileURL } from "node:url";
import { createDolarClient } from "../clients/dolar.js";
import {
	type FallbackVerifier,
	fliDegradationAlert,
	isFallbackVerifier,
} from "../clients/fallbackVerifier.js";
import {
	createVerifier,
	type FlightVerifier,
	googleFlightsUrl,
	type VerificationResult,
} from "../clients/flightVerifier.js";
import { createTelegramClient } from "../clients/telegram.js";
import { loadConfigSubset } from "../config.js";
import { AUTO_PUBLISH_GRACE_MS } from "../curation/autoPublish.js";
import {
	type CandidateWithRoute,
	createDb,
	createSupabase,
	type Deal,
	type DealPatch,
	type DealStatus,
} from "../db/queries.js";
import {
	formatAutoPublishAlert,
	formatCuratorAlert,
	formatDealPost,
} from "../publish/format.js";

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
	/**
	 * How many candidates to verify this run. With a free provider (fli) this
	 * is the high free cap; with a paid-only provider it equals `budget`.
	 */
	candidateLimit: number;
	/**
	 * Hard cap of PAID calls for this run (MAX_VERIFICATIONS_PER_RUN). For fli
	 * this bounds only the SearchApi fallback; for searchapi it bounds every
	 * call (so callers set candidateLimit === budget).
	 */
	budget: number;
	/** Pause between provider calls (ms) to avoid hammering fli's source. */
	pauseMs?: number;
	/**
	 * Called after a deal is confirmed so the curator can approve it.
	 * Failures are logged but never fail the verification itself.
	 */
	notifyCurator?: (deal: CandidateWithRoute) => Promise<void>;
	/**
	 * Operator alert (e.g. Telegram) emitted once at end of run when the fli
	 * primary degraded or collapsed. Failures are logged, never thrown.
	 */
	notifyOperator?: (text: string) => Promise<void>;
	log?: (line: string) => void;
}

/**
 * Layer 3: re-checks the top candidates against a live-price provider.
 * Confirmed deals move to `verified`; vanished prices to `rejected`.
 * A provider error leaves the deal as `candidate` so a later run can
 * retry it — and never counts as a rejection.
 */
const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export async function runVerify(deps: VerifyDeps): Promise<VerifySummary> {
	const log = deps.log ?? console.log;
	const pauseMs = deps.pauseMs ?? 0;
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

	const fallback = isFallbackVerifier(deps.verifier) ? deps.verifier : null;
	let countedPaidCalls = 0;

	// Confirms / rejects a candidate from a verification result. Used by both
	// the main pass and the end-of-run retry pass.
	const apply = async (
		candidate: CandidateWithRoute,
		result: VerificationResult,
	): Promise<void> => {
		const { origin, destination } = candidate.routes;
		const label = `${origin}-${destination} ${candidate.depart_date}`;
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
			if (deps.notifyCurator) {
				try {
					await deps.notifyCurator({
						...candidate,
						status: "verified",
						verified_price_usd: livePriceUsd,
						airline: result.airline ?? candidate.airline,
						direct: result.direct ?? candidate.direct,
					});
				} catch (notifyError) {
					log(
						`verify: curator notification failed for ${label}: ${String(notifyError)}`,
					);
				}
			}
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
	};

	const candidates = await deps.db.getTopCandidates(deps.candidateLimit);
	const errored: CandidateWithRoute[] = [];
	let firstCall = true;
	for (const candidate of candidates) {
		const { origin, destination } = candidate.routes;
		const label = `${origin}-${destination} ${candidate.depart_date}`;
		summary.processed += 1;
		if (!firstCall && pauseMs > 0) await sleep(pauseMs);
		firstCall = false;
		try {
			if (!fallback) countedPaidCalls += 1;
			const result = await deps.verifier.verify(
				origin,
				destination,
				candidate.depart_date,
				candidate.return_date ?? undefined,
			);
			await apply(candidate, result);
		} catch (error) {
			// Provider failure: queue for a free primary-only retry (fli), or
			// leave as candidate for a future run when no retry is available.
			const reason = error instanceof Error ? error.message : String(error);
			errored.push(candidate);
			log(`verify: error ${label}: ${reason}`);
		}
	}

	// End-of-run retry: give fli one more (free) attempt at the candidates that
	// errored, before giving up on them this run.
	if (fallback && errored.length > 0) {
		log(`verify: retrying ${errored.length} errored candidate(s) with fli`);
		for (const candidate of errored) {
			const { origin, destination } = candidate.routes;
			const label = `${origin}-${destination} ${candidate.depart_date}`;
			if (pauseMs > 0) await sleep(pauseMs);
			try {
				const result = await fallback.verifyPrimaryOnly(
					origin,
					destination,
					candidate.depart_date,
					candidate.return_date ?? undefined,
				);
				await apply(candidate, result);
			} catch (error) {
				summary.errors += 1;
				const reason = error instanceof Error ? error.message : String(error);
				log(`verify: ERROR ${label} left as candidate: ${reason}`);
			}
		}
	} else {
		for (const candidate of errored) {
			summary.errors += 1;
			const { origin, destination } = candidate.routes;
			log(
				`verify: ERROR ${origin}-${destination} ${candidate.depart_date} left as candidate`,
			);
		}
	}

	summary.paidCalls = fallback
		? fallback.stats.fallbackCalls
		: countedPaidCalls;
	summary.durationMs = Date.now() - startedAt;
	if (summary.errors > 0 && summary.confirmed === 0 && summary.rejected === 0) {
		log(
			"verify: ERROR provider failing on every call — nothing verified, nothing will be published",
		);
	}
	if (fallback) await alertOnFliDegradation(fallback, deps.notifyOperator, log);
	log(
		`verify: ${summary.processed} processed, ${summary.confirmed} confirmed, ` +
			`${summary.rejected} rejected, ${summary.errors} errors, ` +
			`paid calls ${summary.paidCalls}/${summary.budget}, ` +
			`${(summary.durationMs / 1000).toFixed(1)}s`,
	);
	return summary;
}

/** Emits one operator alert per run when the fli primary failed. */
async function alertOnFliDegradation(
	verifier: FallbackVerifier,
	notify: ((text: string) => Promise<void>) | undefined,
	log: (line: string) => void,
): Promise<void> {
	const text = fliDegradationAlert(verifier.stats);
	if (text === null) return;
	log(`verify: ${text}`);
	if (!notify) return;
	try {
		await notify(text);
	} catch (error) {
		log(`verify: operator alert failed: ${String(error)}`);
	}
}

export async function main(): Promise<void> {
	const config = loadConfigSubset(
		"SUPABASE_URL",
		"SUPABASE_SERVICE_ROLE_KEY",
		"VERIFIER_PROVIDER",
		"SEARCHAPI_KEY",
		"FLIGHTAPI_KEY",
		"MAX_VERIFICATIONS_PER_RUN",
		"FLI_MAX_VERIFICATIONS_PER_RUN",
		"FLI_PAUSE_MS",
		"TELEGRAM_BOT_TOKEN",
		"CURATOR_CHAT_ID",
		"REDIRECT_BASE_URL",
		"AUTO_PUBLISH",
	);
	const db = createDb(
		createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
	);
	const usingFli = config.VERIFIER_PROVIDER === "fli";
	// fli is free, so verify sweeps the high free cap; the paid budget bounds
	// only its SearchApi fallback. A paid-only provider verifies exactly as
	// many candidates as it can pay for.
	const candidateLimit = usingFli
		? config.FLI_MAX_VERIFICATIONS_PER_RUN
		: config.MAX_VERIFICATIONS_PER_RUN;
	const verifier = createVerifier(
		config.VERIFIER_PROVIDER,
		{
			...(config.SEARCHAPI_KEY ? { searchApiKey: config.SEARCHAPI_KEY } : {}),
			...(config.FLIGHTAPI_KEY ? { flightApiKey: config.FLIGHTAPI_KEY } : {}),
		},
		{ fallbackBudget: config.MAX_VERIFICATIONS_PER_RUN },
	);
	const telegram = createTelegramClient(config.TELEGRAM_BOT_TOKEN);
	const dolar = createDolarClient();

	// In auto-publish mode the curator sees the exact post that will go
	// out (plus the countdown); otherwise the classic data alert.
	const alertText = async (deal: CandidateWithRoute): Promise<string> => {
		if (config.AUTO_PUBLISH) {
			const post = formatDealPost({
				dealId: deal.id,
				origin: deal.routes.origin,
				destination: deal.routes.destination,
				priceUsd: deal.verified_price_usd as number,
				arsRate: await dolar.getTarjetaRate(),
				discountPct: deal.discount_pct,
				airline: deal.airline,
				direct: deal.direct,
				departDate: deal.depart_date,
				returnDate: deal.return_date,
				isErrorFare: deal.is_error_fare,
				redirectBaseUrl: config.REDIRECT_BASE_URL,
			});
			return formatAutoPublishAlert(post, AUTO_PUBLISH_GRACE_MS / 60_000);
		}
		return formatCuratorAlert({
			origin: deal.routes.origin,
			destination: deal.routes.destination,
			cachedPriceUsd: deal.cached_price_usd,
			verifiedPriceUsd: deal.verified_price_usd as number,
			medianAtDetection: deal.median_at_detection,
			discountPct: deal.discount_pct,
			airline: deal.airline,
			direct: deal.direct,
			departDate: deal.depart_date,
			returnDate: deal.return_date,
			score: deal.score,
			isErrorFare: deal.is_error_fare,
		});
	};

	const summary = await runVerify({
		db,
		verifier,
		candidateLimit,
		budget: config.MAX_VERIFICATIONS_PER_RUN,
		pauseMs: usingFli ? config.FLI_PAUSE_MS : 0,
		notifyCurator: async (deal) => {
			await telegram.sendWithApprovalButtons(
				config.CURATOR_CHAT_ID,
				await alertText(deal),
				deal.id,
			);
		},
		notifyOperator: async (text) => {
			await telegram.send(config.CURATOR_CHAT_ID, text);
		},
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
