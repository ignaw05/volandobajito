import type { DealStatus, DealWithRoute } from "../db/queries.js";

/**
 * AUTO_PUBLISH mode: a verified deal that the curator did not reject
 * within the grace window is published automatically. The sweep runs
 * inside the curation bot process — if the bot is down, nothing gets
 * auto-published (a stale price is worse than a late post).
 */

export const AUTO_PUBLISH_GRACE_MS = 5 * 60_000;
/**
 * Deals verified longer ago than this are NOT auto-published: if the bot
 * was down for hours the live price may be gone. They stay `verified`
 * and are recoverable manually via /pending.
 */
export const AUTO_PUBLISH_MAX_AGE_MS = 60 * 60_000;
export const SWEEP_INTERVAL_MS = 30_000;

export interface AutoPublishDeps {
	db: {
		getDealsWithRoutesByStatus(status: DealStatus): Promise<DealWithRoute[]>;
	};
	publishDeal(deal: DealWithRoute): Promise<void>;
	/** Deal ids being published right now; shared with the bot's ✅ handler. */
	inFlight: Set<string>;
	/** Tells the curator a deal went out on its own. Failures only logged. */
	notifyCurator?: (text: string) => Promise<void>;
	now?: () => number;
	log?: (line: string) => void;
}

export interface SweepSummary {
	published: number;
	waiting: number;
	stale: number;
	errors: number;
}

export async function runAutoPublishSweep(
	deps: AutoPublishDeps,
): Promise<SweepSummary> {
	const log = deps.log ?? console.log;
	const now = deps.now ?? Date.now;
	const summary: SweepSummary = {
		published: 0,
		waiting: 0,
		stale: 0,
		errors: 0,
	};

	const verified = await deps.db.getDealsWithRoutesByStatus("verified");
	for (const deal of verified) {
		if (deal.verified_at === null) continue;
		const age = now() - Date.parse(deal.verified_at);
		if (age < AUTO_PUBLISH_GRACE_MS) {
			summary.waiting += 1;
			continue;
		}
		if (age > AUTO_PUBLISH_MAX_AGE_MS) {
			summary.stale += 1;
			continue;
		}
		if (deps.inFlight.has(deal.id)) continue;

		deps.inFlight.add(deal.id);
		const label = `${deal.routes.origin}-${deal.routes.destination}`;
		try {
			await deps.publishDeal(deal);
			summary.published += 1;
			log(`auto-publish: published ${label} (${deal.id})`);
			if (deps.notifyCurator) {
				try {
					await deps.notifyCurator(
						`🤖 Auto-publicado: ${deal.routes.origin} → ${deal.routes.destination} (sin rechazo en ${AUTO_PUBLISH_GRACE_MS / 60_000} min)`,
					);
				} catch (notifyError) {
					log(
						`auto-publish: curator notification failed for ${label}: ${String(notifyError)}`,
					);
				}
			}
		} catch (error) {
			summary.errors += 1;
			log(`auto-publish: failed ${label} (${deal.id}): ${String(error)}`);
		} finally {
			deps.inFlight.delete(deal.id);
		}
	}
	return summary;
}
