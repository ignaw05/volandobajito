import { describe, expect, it } from "vitest";
import type {
	Deal,
	DealPatch,
	DealStatus,
	DealWithRoute,
} from "../src/db/queries.js";
import { type PublishDeps, publishDeal } from "../src/publish/publish.js";

function deal(overrides: Partial<DealWithRoute> = {}): DealWithRoute {
	return {
		id: "deal-1",
		route_id: 1,
		status: "verified",
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
		published_at: null,
		expired_at: null,
		telegram_message_id: null,
		rejection_reason: null,
		routes: { origin: "EZE", destination: "MAD" },
		...overrides,
	};
}

function harness(arsRate: number | null = 1500) {
	const transitions: { id: string; status: DealStatus; patch?: DealPatch }[] =
		[];
	const sentPosts: string[] = [];
	const logs: string[] = [];
	const deps: PublishDeps = {
		db: {
			transitionDeal: async (id, status, patch) => {
				transitions.push(
					patch === undefined ? { id, status } : { id, status, patch },
				);
				return { id, status } as Deal;
			},
		},
		sendToChannel: async (text) => {
			sentPosts.push(text);
			return 777;
		},
		getArsRate: async () => arsRate,
		redirectBaseUrl: "https://go.example.com",
		log: (line) => logs.push(line),
	};
	return { deps, transitions, sentPosts, logs };
}

describe("publishDeal", () => {
	it("posts the formatted deal and stamps the message id", async () => {
		const { deps, transitions, sentPosts } = harness();
		await publishDeal(deps, deal());
		expect(sentPosts.length).toBe(1);
		expect(sentPosts[0]).toContain("Buenos Aires → Madrid");
		expect(sentPosts[0]).toContain("USD 489");
		expect(sentPosts[0]).toContain("https://go.example.com/go/deal-1");
		expect(transitions).toEqual([
			{
				id: "deal-1",
				status: "published",
				patch: { telegram_message_id: 777 },
			},
		]);
	});

	it("publishes USD-only when dolarapi is down, and logs it", async () => {
		const { deps, sentPosts, logs } = harness(null);
		await publishDeal(deps, deal());
		expect(sentPosts[0]).not.toContain("dólar tarjeta");
		expect(logs.some((line) => line.includes("USD-only"))).toBe(true);
	});

	it("refuses to publish a deal that is not verified", async () => {
		const { deps, sentPosts, transitions } = harness();
		await expect(
			publishDeal(deps, deal({ status: "candidate" })),
		).rejects.toThrow(/refusing/);
		expect(sentPosts).toEqual([]);
		expect(transitions).toEqual([]);
	});

	it("refuses to publish without a verified price (cache is never user-facing)", async () => {
		const { deps, sentPosts } = harness();
		await expect(
			publishDeal(deps, deal({ verified_price_usd: null })),
		).rejects.toThrow(/refusing/);
		expect(sentPosts).toEqual([]);
	});
});
