import type {
	Deal,
	DealPatch,
	DealStatus,
	DealWithRoute,
} from "../db/queries.js";
import { formatDealPost } from "./format.js";

export interface PublishDeps {
	db: {
		transitionDeal(
			id: string,
			status: DealStatus,
			patch?: DealPatch,
		): Promise<Deal>;
	};
	/** Sends to the public channel; returns the Telegram message id. */
	sendToChannel(text: string): Promise<number>;
	/** ARS-per-USD tarjeta rate, or null to publish USD-only. */
	getArsRate(): Promise<number | null>;
	redirectBaseUrl: string;
	log?: (line: string) => void;
}

/**
 * Publishes an approved deal to the channel and stamps the message id.
 * Guard rail: only `verified` deals with a verified price may ever be
 * published — the cached price is never user-facing.
 */
export async function publishDeal(
	deps: PublishDeps,
	deal: DealWithRoute,
): Promise<Deal> {
	if (deal.status !== "verified" || deal.verified_price_usd === null) {
		throw new Error(
			`publish: refusing deal ${deal.id} (status=${deal.status}, verified_price=${deal.verified_price_usd})`,
		);
	}
	const log = deps.log ?? console.log;
	const arsRate = await deps.getArsRate();
	if (arsRate === null) {
		log("publish: dolarapi unavailable, publishing USD-only");
	}
	const post = formatDealPost({
		dealId: deal.id,
		origin: deal.routes.origin,
		destination: deal.routes.destination,
		priceUsd: deal.verified_price_usd,
		arsRate,
		discountPct: deal.discount_pct,
		airline: deal.airline,
		direct: deal.direct,
		departDate: deal.depart_date,
		returnDate: deal.return_date,
		isErrorFare: deal.is_error_fare,
		redirectBaseUrl: deps.redirectBaseUrl,
	});
	const messageId = await deps.sendToChannel(post);
	const published = await deps.db.transitionDeal(deal.id, "published", {
		telegram_message_id: messageId,
	});
	log(
		`publish: ${deal.routes.origin}-${deal.routes.destination} ` +
			`USD ${deal.verified_price_usd} -> channel message ${messageId}`,
	);
	return published;
}
