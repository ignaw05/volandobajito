import { pathToFileURL } from "node:url";
import { createDolarClient } from "../clients/dolar.js";
import {
	createVerifier,
	type FlightVerifier,
} from "../clients/flightVerifier.js";
import { createTelegramClient } from "../clients/telegram.js";
import { loadConfigSubset } from "../config.js";
import {
	createDb,
	createSupabase,
	type Deal,
	type DealPatch,
	type DealStatus,
	type DealWithRoute,
} from "../db/queries.js";
import { formatDealPost, formatExpiredPost } from "../publish/format.js";
import { PRICE_TOLERANCE } from "./verify.js";

/**
 * Hygiene for published deals: re-verifies recent posts against the
 * live-price provider and stamps an EXPIRADO banner on dead fares.
 * Every check is a paid call, so it shares the verification budget.
 */

export const RECHECK_WINDOW_HOURS = 72;

export interface RecheckSummary {
	processed: number;
	alive: number;
	expired: number;
	errors: number;
	/** Paid provider calls actually spent this run. */
	paidCalls: number;
	budget: number;
	durationMs: number;
}

export interface RecheckDeps {
	db: {
		getPublishedDealsSince(sinceIso: string): Promise<DealWithRoute[]>;
		transitionDeal(
			id: string,
			status: DealStatus,
			patch?: DealPatch,
		): Promise<Deal>;
	};
	verifier: FlightVerifier;
	/** Hard cap of paid calls for this run (MAX_VERIFICATIONS_PER_RUN). */
	budget: number;
	/** Edits the original channel post (to prepend the expired banner). */
	editChannelPost(messageId: number, text: string): Promise<void>;
	/** ARS-per-USD tarjeta rate, or null for USD-only (banner text only). */
	getArsRate(): Promise<number | null>;
	redirectBaseUrl: string;
	now?: () => number;
	log?: (line: string) => void;
}

export async function runRecheck(deps: RecheckDeps): Promise<RecheckSummary> {
	const log = deps.log ?? console.log;
	const now = deps.now ?? Date.now;
	const startedAt = now();
	const summary: RecheckSummary = {
		processed: 0,
		alive: 0,
		expired: 0,
		errors: 0,
		paidCalls: 0,
		budget: deps.budget,
		durationMs: 0,
	};

	const sinceIso = new Date(
		startedAt - RECHECK_WINDOW_HOURS * 3_600_000,
	).toISOString();
	const deals = await deps.db.getPublishedDealsSince(sinceIso);
	log(
		`recheck: ${deals.length} published deal(s) in the last ${RECHECK_WINDOW_HOURS}h`,
	);

	for (const deal of deals) {
		if (summary.paidCalls >= deps.budget) {
			log(
				`recheck: budget exhausted (${deps.budget}), ${deals.length - summary.processed} deal(s) left unchecked`,
			);
			break;
		}
		const { origin, destination } = deal.routes;
		const label = `${origin}-${destination} ${deal.depart_date}`;
		summary.processed += 1;
		try {
			summary.paidCalls += 1;
			const result = await deps.verifier.verify(
				origin,
				destination,
				deal.depart_date,
				deal.return_date ?? undefined,
			);
			const baseline = deal.verified_price_usd ?? deal.cached_price_usd;
			const stillAlive =
				result.alive &&
				result.priceUsd !== undefined &&
				result.priceUsd <= baseline * PRICE_TOLERANCE;

			if (stillAlive) {
				summary.alive += 1;
				log(`recheck: still alive ${label} live=$${result.priceUsd}`);
				continue;
			}

			// The post text is not stored: rebuild it from the deal row and
			// prepend the banner. The ARS figure may differ slightly from the
			// original post — irrelevant on an expired fare.
			if (deal.telegram_message_id !== null) {
				const post = formatDealPost({
					dealId: deal.id,
					origin,
					destination,
					priceUsd: baseline,
					arsRate: await deps.getArsRate(),
					discountPct: deal.discount_pct,
					airline: deal.airline,
					direct: deal.direct,
					departDate: deal.depart_date,
					returnDate: deal.return_date,
					isErrorFare: deal.is_error_fare,
					redirectBaseUrl: deps.redirectBaseUrl,
				});
				try {
					await deps.editChannelPost(
						deal.telegram_message_id,
						formatExpiredPost(post),
					);
				} catch (editError) {
					// The deal still expires: a stale banner is recoverable, a
					// dead fare kept as "published" is not.
					log(
						`recheck: failed to edit channel post for ${label}: ${String(editError)}`,
					);
				}
			}
			await deps.db.transitionDeal(deal.id, "expired");
			summary.expired += 1;
			const live =
				result.priceUsd === undefined ? "none" : `$${result.priceUsd}`;
			log(`recheck: EXPIRED ${label} baseline=$${baseline} live=${live}`);
		} catch (error) {
			// Provider failure: keep it published, a later run retries.
			summary.errors += 1;
			const reason = error instanceof Error ? error.message : String(error);
			log(`recheck: ERROR ${label} left as published: ${reason}`);
		}
	}

	summary.durationMs = now() - startedAt;
	log(
		`recheck: ${summary.processed} processed, ${summary.alive} alive, ` +
			`${summary.expired} expired, ${summary.errors} errors, ` +
			`paid calls ${summary.paidCalls}/${summary.budget}, ` +
			`${(summary.durationMs / 1000).toFixed(1)}s`,
	);
	return summary;
}

async function main(): Promise<void> {
	const silent = loadConfigSubset("SILENT_MODE");
	if (silent.SILENT_MODE) {
		// Test mode (plan §Fase 4): the cron never spends paid calls and
		// there are no published deals to recheck yet.
		console.log("recheck: SILENT_MODE=true — paid recheck disabled, exiting");
		return;
	}
	const config = loadConfigSubset(
		"SUPABASE_URL",
		"SUPABASE_SERVICE_ROLE_KEY",
		"VERIFIER_PROVIDER",
		"SEARCHAPI_KEY",
		"FLIGHTAPI_KEY",
		"MAX_VERIFICATIONS_PER_RUN",
		"TELEGRAM_BOT_TOKEN",
		"CHANNEL_ID",
		"REDIRECT_BASE_URL",
	);
	const db = createDb(
		createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
	);
	const verifier = createVerifier(config.VERIFIER_PROVIDER, {
		...(config.SEARCHAPI_KEY ? { searchApiKey: config.SEARCHAPI_KEY } : {}),
		...(config.FLIGHTAPI_KEY ? { flightApiKey: config.FLIGHTAPI_KEY } : {}),
	});
	const telegram = createTelegramClient(config.TELEGRAM_BOT_TOKEN);
	const dolar = createDolarClient();
	const summary = await runRecheck({
		db,
		verifier,
		budget: config.MAX_VERIFICATIONS_PER_RUN,
		editChannelPost: (messageId, text) =>
			telegram.editText(config.CHANNEL_ID, messageId, text),
		getArsRate: () => dolar.getTarjetaRate(),
		redirectBaseUrl: config.REDIRECT_BASE_URL,
	});
	if (summary.errors > 0 && summary.alive === 0 && summary.expired === 0) {
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
