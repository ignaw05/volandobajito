import type { NewClickEvent } from "../db/queries.js";

/** Request metadata recorded with each click. */
export interface ClickMeta {
	userAgent: string | null;
	referer: string | null;
}

export interface RedirectDeps {
	db: {
		getDealWithRouteById(
			id: string,
		): Promise<{ booking_url: string | null } | null>;
		recordClick(event: NewClickEvent): Promise<void>;
	};
	/**
	 * Schedules background work that must not delay the response. On Vercel
	 * this is waitUntil(); a floating promise would be killed when the
	 * serverless invocation returns.
	 */
	waitUntil: (work: Promise<unknown>) => void;
	log?: (line: string) => void;
}

export type RedirectResult =
	| { kind: "redirect"; location: string }
	| { kind: "not_found" };

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves /go/:dealId. The click insert is fire-and-forget: the user's
 * click is never sacrificed for the metric. A failing DB lookup answers
 * not_found rather than surfacing a 500 to someone tapping a link.
 */
export async function resolveRedirect(
	deps: RedirectDeps,
	dealId: string,
	meta: ClickMeta,
): Promise<RedirectResult> {
	const log = deps.log ?? console.error;
	if (!UUID_PATTERN.test(dealId)) {
		return { kind: "not_found" };
	}

	let deal: { booking_url: string | null } | null;
	try {
		deal = await deps.db.getDealWithRouteById(dealId);
	} catch (error) {
		log(`redirect: deal lookup failed: ${String(error)}`);
		return { kind: "not_found" };
	}
	if (deal === null || deal.booking_url === null) {
		return { kind: "not_found" };
	}

	deps.waitUntil(
		deps.db
			.recordClick({
				deal_id: dealId,
				user_agent: meta.userAgent,
				referer: meta.referer,
			})
			.catch((error) => {
				log(`redirect: recordClick failed: ${String(error)}`);
			}),
	);

	return { kind: "redirect", location: deal.booking_url };
}
