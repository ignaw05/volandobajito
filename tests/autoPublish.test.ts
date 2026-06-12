import { describe, expect, it } from "vitest";
import {
	AUTO_PUBLISH_GRACE_MS,
	AUTO_PUBLISH_MAX_AGE_MS,
	type AutoPublishDeps,
	runAutoPublishSweep,
} from "../src/curation/autoPublish.js";
import type { DealWithRoute } from "../src/db/queries.js";

const NOW = Date.parse("2026-06-12T12:00:00Z");

function verifiedDeal(
	id: string,
	verifiedAgoMs: number,
	overrides: Partial<DealWithRoute> = {},
): DealWithRoute {
	return {
		id,
		route_id: 1,
		status: "verified",
		depart_date: "2026-08-19",
		return_date: "2026-09-08",
		cached_price_usd: 470,
		verified_price_usd: 489,
		airline: "Iberia",
		direct: true,
		booking_url: "https://www.google.com/travel/flights?tfs=abc",
		median_at_detection: 800,
		discount_pct: 0.38,
		score: 60,
		is_error_fare: false,
		detected_at: new Date(NOW - verifiedAgoMs - 3_600_000).toISOString(),
		verified_at: new Date(NOW - verifiedAgoMs).toISOString(),
		published_at: null,
		expired_at: null,
		telegram_message_id: null,
		rejection_reason: null,
		routes: { origin: "EZE", destination: "MAD" },
		...overrides,
	};
}

interface Harness {
	deps: AutoPublishDeps;
	published: string[];
	notifications: string[];
	logs: string[];
	inFlight: Set<string>;
}

function harness(options: {
	verified: DealWithRoute[];
	inFlight?: Set<string>;
	failPublishIds?: string[];
}): Harness {
	const published: string[] = [];
	const notifications: string[] = [];
	const logs: string[] = [];
	const inFlight = options.inFlight ?? new Set<string>();
	const deps: AutoPublishDeps = {
		db: {
			getDealsWithRoutesByStatus: async () => options.verified,
		},
		publishDeal: async (deal) => {
			if (options.failPublishIds?.includes(deal.id)) {
				throw new Error(`channel down for ${deal.id}`);
			}
			published.push(deal.id);
		},
		inFlight,
		notifyCurator: async (text) => {
			notifications.push(text);
		},
		now: () => NOW,
		log: (line) => logs.push(line),
	};
	return { deps, published, notifications, logs, inFlight };
}

const PAST_GRACE = AUTO_PUBLISH_GRACE_MS + 60_000;

describe("runAutoPublishSweep", () => {
	it("publishes a deal past the grace window and notifies the curator", async () => {
		const h = harness({ verified: [verifiedDeal("d1", PAST_GRACE)] });
		const summary = await runAutoPublishSweep(h.deps);
		expect(h.published).toEqual(["d1"]);
		expect(summary.published).toBe(1);
		expect(h.notifications[0]).toContain("Auto-publicado: EZE → MAD");
	});

	it("waits on a deal still inside the grace window", async () => {
		const h = harness({ verified: [verifiedDeal("d1", 2 * 60_000)] });
		const summary = await runAutoPublishSweep(h.deps);
		expect(h.published).toEqual([]);
		expect(summary.waiting).toBe(1);
	});

	it("never auto-publishes a stale verification (bot was down too long)", async () => {
		const h = harness({
			verified: [verifiedDeal("d1", AUTO_PUBLISH_MAX_AGE_MS + 60_000)],
		});
		const summary = await runAutoPublishSweep(h.deps);
		expect(h.published).toEqual([]);
		expect(summary.stale).toBe(1);
	});

	it("skips a deal already being published by the ✅ handler", async () => {
		const h = harness({
			verified: [verifiedDeal("d1", PAST_GRACE)],
			inFlight: new Set(["d1"]),
		});
		const summary = await runAutoPublishSweep(h.deps);
		expect(h.published).toEqual([]);
		expect(summary.published).toBe(0);
	});

	it("releases the in-flight guard after publishing", async () => {
		const h = harness({ verified: [verifiedDeal("d1", PAST_GRACE)] });
		await runAutoPublishSweep(h.deps);
		expect(h.inFlight.size).toBe(0);
	});

	it("a failing publish is logged and does not stop the sweep", async () => {
		const h = harness({
			verified: [
				verifiedDeal("d1", PAST_GRACE),
				verifiedDeal("d2", PAST_GRACE),
			],
			failPublishIds: ["d1"],
		});
		const summary = await runAutoPublishSweep(h.deps);
		expect(h.published).toEqual(["d2"]);
		expect(summary.errors).toBe(1);
		expect(h.logs.some((line) => line.includes("failed EZE-MAD (d1)"))).toBe(
			true,
		);
		expect(h.inFlight.size).toBe(0);
	});
});
