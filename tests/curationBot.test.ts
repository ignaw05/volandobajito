import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
	type CurationBotDeps,
	registerCurationHandlers,
} from "../src/curation/bot.js";
import type {
	Deal,
	DealPatch,
	DealStatus,
	DealWithRoute,
	FunnelStats,
} from "../src/db/queries.js";

const CURATOR_CHAT_ID = "42";
const STRANGER_CHAT_ID = 999;

const botInfo: UserFromGetMe = {
	id: 1,
	is_bot: true,
	first_name: "curation-test",
	username: "curation_test_bot",
	can_join_groups: false,
	can_read_all_group_messages: false,
	supports_inline_queries: false,
	can_connect_to_business: false,
	has_main_web_app: false,
	can_manage_bots: false,
	has_topics_enabled: false,
	allows_users_to_create_topics: false,
};

function deal(overrides: Partial<DealWithRoute> = {}): DealWithRoute {
	return {
		id: "deal-1",
		route_id: 1,
		status: "verified",
		depart_date: "2026-08-19",
		return_date: "2026-09-08",
		cached_price_usd: 913,
		verified_price_usd: 941,
		airline: "LATAM",
		direct: false,
		booking_url: "https://www.google.com/travel/flights?tfs=abc",
		median_at_detection: 1404,
		discount_pct: 0.35,
		score: 52,
		is_error_fare: false,
		detected_at: "2026-06-12T10:00:00Z",
		verified_at: "2026-06-12T11:00:00Z",
		published_at: null,
		expired_at: null,
		telegram_message_id: null,
		rejection_reason: null,
		routes: { origin: "AEP", destination: "MAD" },
		...overrides,
	};
}

interface Harness {
	bot: Bot;
	apiCalls: { method: string; payload: Record<string, unknown> }[];
	transitions: { id: string; status: DealStatus; patch?: DealPatch }[];
	publishedDeals: DealWithRoute[];
}

function harness(options: {
	dealsById?: Record<string, DealWithRoute>;
	verifiedDeals?: DealWithRoute[];
	stats?: FunnelStats;
}): Harness {
	const apiCalls: Harness["apiCalls"] = [];
	const transitions: Harness["transitions"] = [];
	const publishedDeals: DealWithRoute[] = [];

	const deps: CurationBotDeps = {
		db: {
			getDealWithRouteById: async (id) => options.dealsById?.[id] ?? null,
			getDealsWithRoutesByStatus: async () => options.verifiedDeals ?? [],
			transitionDeal: async (id, status, patch) => {
				transitions.push(
					patch === undefined ? { id, status } : { id, status, patch },
				);
				return { id } as Deal;
			},
			getFunnelStatsSince: async () =>
				options.stats ?? {
					candidates: 0,
					verified: 0,
					published: 0,
					clicks: 0,
				},
		},
		publishDeal: async (d) => {
			publishedDeals.push(d);
		},
		curatorChatId: CURATOR_CHAT_ID,
		log: () => {},
	};

	const bot = new Bot("test-token", { botInfo });
	// Capture every outbound Bot API call instead of hitting Telegram.
	bot.api.config.use(async (_prev, method, payload) => {
		apiCalls.push({ method, payload: payload as Record<string, unknown> });
		return { ok: true, result: true } as unknown as never;
	});
	registerCurationHandlers(bot, deps);
	return { bot, apiCalls, transitions, publishedDeals };
}

let updateSeq = 0;

function callbackUpdate(chatId: number, data: string): Update {
	updateSeq += 1;
	return {
		update_id: updateSeq,
		callback_query: {
			id: `cb-${updateSeq}`,
			from: { id: chatId, is_bot: false, first_name: "tester" },
			message: {
				message_id: 100,
				date: 1765000000,
				chat: { id: chatId, type: "private", first_name: "tester" },
				text: "alerta original",
			},
			chat_instance: "ci",
			data,
		},
	} as Update;
}

function commandUpdate(chatId: number, text: string): Update {
	updateSeq += 1;
	return {
		update_id: updateSeq,
		message: {
			message_id: 200,
			date: 1765000000,
			chat: { id: chatId, type: "private", first_name: "tester" },
			from: { id: chatId, is_bot: false, first_name: "tester" },
			text,
			entities: [{ type: "bot_command", offset: 0, length: text.length }],
		},
	} as Update;
}

describe("curation bot gate", () => {
	it("silently ignores any chat that is not the curator", async () => {
		const h = harness({ dealsById: { "deal-1": deal() } });
		await h.bot.handleUpdate(
			callbackUpdate(STRANGER_CHAT_ID, "publish:deal-1"),
		);
		await h.bot.handleUpdate(commandUpdate(STRANGER_CHAT_ID, "/pending"));
		await h.bot.handleUpdate(commandUpdate(STRANGER_CHAT_ID, "/stats"));
		expect(h.apiCalls).toEqual([]);
		expect(h.publishedDeals).toEqual([]);
		expect(h.transitions).toEqual([]);
	});
});

describe("publish callback", () => {
	it("publishes a verified deal and marks the alert resolved", async () => {
		const h = harness({ dealsById: { "deal-1": deal() } });
		await h.bot.handleUpdate(
			callbackUpdate(Number(CURATOR_CHAT_ID), "publish:deal-1"),
		);
		expect(h.publishedDeals.map((d) => d.id)).toEqual(["deal-1"]);
		const methods = h.apiCalls.map((c) => c.method);
		expect(methods).toContain("answerCallbackQuery");
		expect(methods).toContain("editMessageText");
		const edit = h.apiCalls.find((c) => c.method === "editMessageText");
		expect(edit?.payload.text).toContain("✅ Publicado");
	});

	it("does not double-publish an already resolved deal", async () => {
		const h = harness({
			dealsById: { "deal-1": deal({ status: "published" }) },
		});
		await h.bot.handleUpdate(
			callbackUpdate(Number(CURATOR_CHAT_ID), "publish:deal-1"),
		);
		expect(h.publishedDeals).toEqual([]);
		const answer = h.apiCalls.find((c) => c.method === "answerCallbackQuery");
		expect(answer?.payload.text).toContain("Ya resuelto");
	});

	it("answers gracefully for a missing deal", async () => {
		const h = harness({});
		await h.bot.handleUpdate(
			callbackUpdate(Number(CURATOR_CHAT_ID), "publish:nope"),
		);
		expect(h.publishedDeals).toEqual([]);
		const answer = h.apiCalls.find((c) => c.method === "answerCallbackQuery");
		expect(answer?.payload.text).toContain("inexistente");
	});
});

describe("reject callback", () => {
	it("rejects with rejection_reason=curator", async () => {
		const h = harness({ dealsById: { "deal-1": deal() } });
		await h.bot.handleUpdate(
			callbackUpdate(Number(CURATOR_CHAT_ID), "reject:deal-1"),
		);
		expect(h.transitions).toEqual([
			{
				id: "deal-1",
				status: "rejected",
				patch: { rejection_reason: "curator" },
			},
		]);
		expect(h.publishedDeals).toEqual([]);
	});
});

describe("/pending", () => {
	it("re-sends each unresolved deal with approval buttons", async () => {
		const h = harness({
			verifiedDeals: [deal(), deal({ id: "deal-2" })],
		});
		await h.bot.handleUpdate(
			commandUpdate(Number(CURATOR_CHAT_ID), "/pending"),
		);
		const sends = h.apiCalls.filter((c) => c.method === "sendMessage");
		// Header + one message per pending deal.
		expect(sends.length).toBe(3);
		expect(sends[0]?.payload.text).toContain("2 deal(s) pendiente(s)");
		expect(sends[1]?.payload.reply_markup).toBeDefined();
	});

	it("says so when there is nothing pending", async () => {
		const h = harness({ verifiedDeals: [] });
		await h.bot.handleUpdate(
			commandUpdate(Number(CURATOR_CHAT_ID), "/pending"),
		);
		const sends = h.apiCalls.filter((c) => c.method === "sendMessage");
		expect(sends.length).toBe(1);
		expect(sends[0]?.payload.text).toContain("No hay deals pendientes");
	});
});

describe("/stats", () => {
	it("reports the 24h funnel counters", async () => {
		const h = harness({
			stats: { candidates: 7, verified: 3, published: 1, clicks: 12 },
		});
		await h.bot.handleUpdate(commandUpdate(Number(CURATOR_CHAT_ID), "/stats"));
		const send = h.apiCalls.find((c) => c.method === "sendMessage");
		expect(send?.payload.text).toContain("Candidatos: 7");
		expect(send?.payload.text).toContain("Verificados: 3");
		expect(send?.payload.text).toContain("Publicados: 1");
		expect(send?.payload.text).toContain("Clicks: 12");
	});
});
