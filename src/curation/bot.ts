import { pathToFileURL } from "node:url";
import { Bot, type CallbackQueryContext, type Context } from "grammy";
import { createDolarClient } from "../clients/dolar.js";
import { approvalKeyboard } from "../clients/telegram.js";
import { loadConfigSubset } from "../config.js";
import {
	createDb,
	createSupabase,
	type Deal,
	type DealPatch,
	type DealStatus,
	type DealWithRoute,
	type FunnelStats,
} from "../db/queries.js";
import { formatCuratorAlert } from "../publish/format.js";
import { publishDeal } from "../publish/publish.js";

/**
 * Private curation bot (long-polling). Every verified deal lands here
 * as a message with inline approve/reject buttons; nothing reaches the
 * public channel without the curator pressing ✅.
 */

const STATS_WINDOW_HOURS = 24;
const PENDING_RESEND_LIMIT = 10;

export interface CurationBotDeps {
	db: {
		getDealWithRouteById(id: string): Promise<DealWithRoute | null>;
		getDealsWithRoutesByStatus(status: DealStatus): Promise<DealWithRoute[]>;
		transitionDeal(
			id: string,
			status: DealStatus,
			patch?: DealPatch,
		): Promise<Deal>;
		getFunnelStatsSince(sinceIso: string): Promise<FunnelStats>;
	};
	/** Publishes an approved deal to the public channel (Fase 5 publisher). */
	publishDeal(deal: DealWithRoute): Promise<void>;
	curatorChatId: string;
	now?: () => number;
	log?: (line: string) => void;
}

function curatorAlertText(deal: DealWithRoute): string {
	return formatCuratorAlert({
		origin: deal.routes.origin,
		destination: deal.routes.destination,
		cachedPriceUsd: deal.cached_price_usd,
		verifiedPriceUsd: deal.verified_price_usd ?? deal.cached_price_usd,
		medianAtDetection: deal.median_at_detection,
		discountPct: deal.discount_pct,
		airline: deal.airline,
		direct: deal.direct,
		departDate: deal.depart_date,
		returnDate: deal.return_date,
		score: deal.score,
		isErrorFare: deal.is_error_fare,
	});
}

/**
 * Wires all handlers onto an existing Bot instance. Separated from
 * main() so tests can drive the bot via handleUpdate without network.
 */
export function registerCurationHandlers(
	bot: Bot,
	deps: CurationBotDeps,
): void {
	const log = deps.log ?? console.log;
	const now = deps.now ?? Date.now;

	// Hard gate: only the curator's chat exists. Anyone else is ignored
	// silently — no reply, no log line an attacker could probe with.
	bot.use(async (ctx, next) => {
		const chatId = ctx.chat?.id ?? ctx.from?.id;
		if (chatId === undefined || String(chatId) !== deps.curatorChatId) {
			return;
		}
		await next();
	});

	bot.catch((error) => {
		log(`curation bot: handler error: ${String(error.error)}`);
	});

	// Appends the resolution to the alert message and drops the buttons,
	// so the curator's history shows what happened to each deal.
	async function markResolved(
		ctx: CallbackQueryContext<Context>,
		resolution: string,
	): Promise<void> {
		const original = ctx.callbackQuery.message?.text;
		if (original === undefined) return;
		await ctx.editMessageText(`${original}\n\n${resolution}`);
	}

	bot.callbackQuery(/^publish:(.+)$/, async (ctx) => {
		const dealId = ctx.match?.[1];
		if (!dealId) return;
		const deal = await deps.db.getDealWithRouteById(dealId);
		if (!deal) {
			await ctx.answerCallbackQuery({ text: "Deal inexistente." });
			return;
		}
		if (deal.status !== "verified") {
			await ctx.answerCallbackQuery({
				text: `Ya resuelto (${deal.status}).`,
			});
			return;
		}
		await deps.publishDeal(deal);
		log(
			`curation: published ${deal.routes.origin}-${deal.routes.destination} (${deal.id})`,
		);
		await ctx.answerCallbackQuery({ text: "Publicado ✅" });
		await markResolved(ctx, "✅ Publicado en el canal");
	});

	bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
		const dealId = ctx.match?.[1];
		if (!dealId) return;
		const deal = await deps.db.getDealWithRouteById(dealId);
		if (!deal) {
			await ctx.answerCallbackQuery({ text: "Deal inexistente." });
			return;
		}
		if (deal.status !== "verified") {
			await ctx.answerCallbackQuery({
				text: `Ya resuelto (${deal.status}).`,
			});
			return;
		}
		await deps.db.transitionDeal(deal.id, "rejected", {
			rejection_reason: "curator",
		});
		log(
			`curation: rejected ${deal.routes.origin}-${deal.routes.destination} (${deal.id})`,
		);
		await ctx.answerCallbackQuery({ text: "Rechazado ❌" });
		await markResolved(ctx, "❌ Rechazado");
	});

	// Re-sends each unresolved verified deal with fresh buttons, so a
	// missed or stale alert is always recoverable.
	bot.command("pending", async (ctx) => {
		const pending = await deps.db.getDealsWithRoutesByStatus("verified");
		if (pending.length === 0) {
			await ctx.reply("No hay deals pendientes de curaduría.");
			return;
		}
		await ctx.reply(
			`📋 ${pending.length} deal(s) pendiente(s)` +
				(pending.length > PENDING_RESEND_LIMIT
					? ` (mostrando ${PENDING_RESEND_LIMIT})`
					: "") +
				":",
		);
		for (const deal of pending.slice(0, PENDING_RESEND_LIMIT)) {
			await ctx.reply(curatorAlertText(deal), {
				reply_markup: approvalKeyboard(deal.id),
			});
		}
	});

	bot.command("stats", async (ctx) => {
		const sinceIso = new Date(
			now() - STATS_WINDOW_HOURS * 3_600_000,
		).toISOString();
		const stats = await deps.db.getFunnelStatsSince(sinceIso);
		await ctx.reply(
			[
				`📊 Últimas ${STATS_WINDOW_HOURS} h:`,
				`• Candidatos: ${stats.candidates}`,
				`• Verificados: ${stats.verified}`,
				`• Publicados: ${stats.published}`,
				`• Clicks: ${stats.clicks}`,
			].join("\n"),
		);
	});
}

async function main(): Promise<void> {
	const config = loadConfigSubset(
		"SUPABASE_URL",
		"SUPABASE_SERVICE_ROLE_KEY",
		"TELEGRAM_BOT_TOKEN",
		"CURATOR_CHAT_ID",
		"CHANNEL_ID",
		"REDIRECT_BASE_URL",
	);
	const db = createDb(
		createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
	);
	const dolar = createDolarClient();
	const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

	registerCurationHandlers(bot, {
		db,
		curatorChatId: config.CURATOR_CHAT_ID,
		publishDeal: async (deal) => {
			await publishDeal(
				{
					db,
					sendToChannel: async (text) => {
						const message = await bot.api.sendMessage(config.CHANNEL_ID, text);
						return message.message_id;
					},
					getArsRate: () => dolar.getTarjetaRate(),
					redirectBaseUrl: config.REDIRECT_BASE_URL,
				},
				deal,
			);
		},
	});

	console.log("curation bot: starting long-polling");
	await bot.start();
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
