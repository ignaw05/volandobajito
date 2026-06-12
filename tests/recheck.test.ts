import { describe, expect, it } from "vitest";
import type { VerificationResult } from "../src/clients/flightVerifier.js";
import type {
	Deal,
	DealPatch,
	DealStatus,
	DealWithRoute,
} from "../src/db/queries.js";
import { type RecheckDeps, runRecheck } from "../src/pipeline/recheck.js";

let dealSeq = 0;

function publishedDeal(overrides: Partial<DealWithRoute> = {}): DealWithRoute {
	dealSeq += 1;
	return {
		id: `deal-${dealSeq}`,
		route_id: 1,
		status: "published",
		depart_date: "2027-03-12",
		return_date: "2027-03-28",
		cached_price_usd: 470,
		verified_price_usd: 489,
		airline: "Iberia",
		direct: true,
		booking_url: "https://www.google.com/travel/flights?tfs=abc",
		median_at_detection: 789,
		discount_pct: 0.38,
		score: 60,
		is_error_fare: false,
		detected_at: "2026-06-12T10:00:00Z",
		verified_at: "2026-06-12T11:00:00Z",
		published_at: "2026-06-12T12:00:00Z",
		expired_at: null,
		telegram_message_id: 777,
		rejection_reason: null,
		routes: { origin: "EZE", destination: "MAD" },
		...overrides,
	};
}

function harness(
	deals: DealWithRoute[],
	results: (VerificationResult | Error)[],
	budget = 5,
) {
	const transitions: { id: string; status: DealStatus; patch?: DealPatch }[] =
		[];
	const edits: { messageId: number; text: string }[] = [];
	const logs: string[] = [];
	let call = 0;
	const deps: RecheckDeps = {
		db: {
			getPublishedDealsSince: async () => deals,
			transitionDeal: async (id, status, patch) => {
				transitions.push(
					patch === undefined ? { id, status } : { id, status, patch },
				);
				return { id, status } as Deal;
			},
		},
		verifier: {
			verify: async () => {
				const result = results[Math.min(call, results.length - 1)];
				call += 1;
				if (result instanceof Error) throw result;
				return result as VerificationResult;
			},
		},
		budget,
		editChannelPost: async (messageId, text) => {
			edits.push({ messageId, text });
		},
		getArsRate: async () => 1500,
		redirectBaseUrl: "https://go.example.com",
		log: (line) => logs.push(line),
	};
	return { deps, transitions, edits, logs };
}

describe("runRecheck", () => {
	it("leaves a still-alive deal untouched", async () => {
		const { deps, transitions, edits } = harness(
			[publishedDeal()],
			[{ alive: true, priceUsd: 510 }], // within 15% of 489
		);
		const summary = await runRecheck(deps);
		expect(summary.alive).toBe(1);
		expect(transitions).toEqual([]);
		expect(edits).toEqual([]);
	});

	it("expires a dead fare and stamps the banner on the channel post", async () => {
		const deal = publishedDeal();
		const { deps, transitions, edits } = harness([deal], [{ alive: false }]);
		const summary = await runRecheck(deps);
		expect(summary.expired).toBe(1);
		expect(transitions).toEqual([{ id: deal.id, status: "expired" }]);
		expect(edits.length).toBe(1);
		expect(edits[0]?.messageId).toBe(777);
		expect(edits[0]?.text.startsWith("⚠️ EXPIRADO —")).toBe(true);
		expect(edits[0]?.text).toContain("USD 489");
	});

	it("expires when the live price drifts beyond tolerance", async () => {
		const { deps, transitions } = harness(
			[publishedDeal()],
			[{ alive: true, priceUsd: 700 }], // way past 489 × 1.15
		);
		await runRecheck(deps);
		expect(transitions[0]?.status).toBe("expired");
	});

	it("keeps the deal published on provider error so a later run retries", async () => {
		const { deps, transitions, edits } = harness(
			[publishedDeal()],
			[new Error("searchapi: HTTP 503 after 3 retries")],
		);
		const summary = await runRecheck(deps);
		expect(summary.errors).toBe(1);
		expect(transitions).toEqual([]);
		expect(edits).toEqual([]);
	});

	it("still expires the deal when the channel edit fails", async () => {
		const deal = publishedDeal();
		const { deps, transitions, logs } = harness([deal], [{ alive: false }]);
		deps.editChannelPost = async () => {
			throw new Error("telegram down");
		};
		await runRecheck(deps);
		expect(transitions).toEqual([{ id: deal.id, status: "expired" }]);
		expect(logs.some((line) => line.includes("failed to edit"))).toBe(true);
	});

	it("never spends more paid calls than the budget", async () => {
		const deals = [publishedDeal(), publishedDeal(), publishedDeal()];
		const { deps } = harness(deals, [{ alive: true, priceUsd: 489 }], 2);
		const summary = await runRecheck(deps);
		expect(summary.paidCalls).toBe(2);
		expect(summary.processed).toBe(2);
	});
});
