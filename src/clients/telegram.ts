import { Bot, InlineKeyboard } from "grammy";

/**
 * Thin grammy wrapper for one-shot sends from the pipeline (the
 * long-polling curation bot lives in src/curation/bot.ts and shares
 * the same token). Only the API surface the project needs.
 */

export interface TelegramClient {
	/** Sends plain text; returns the Telegram message id. */
	send(chatId: string | number, text: string): Promise<number>;
	/** Curator alert with inline ✅ Publicar / ❌ Rechazar buttons. */
	sendWithApprovalButtons(
		chatId: string | number,
		text: string,
		dealId: string,
	): Promise<number>;
	editText(
		chatId: string | number,
		messageId: number,
		text: string,
	): Promise<void>;
}

export function approvalKeyboard(dealId: string): InlineKeyboard {
	return new InlineKeyboard()
		.text("✅ Publicar", `publish:${dealId}`)
		.text("❌ Rechazar", `reject:${dealId}`);
}

export function createTelegramClient(token: string): TelegramClient {
	const bot = new Bot(token);
	return {
		async send(chatId, text) {
			const message = await bot.api.sendMessage(chatId, text);
			return message.message_id;
		},
		async sendWithApprovalButtons(chatId, text, dealId) {
			const message = await bot.api.sendMessage(chatId, text, {
				reply_markup: approvalKeyboard(dealId),
			});
			return message.message_id;
		},
		async editText(chatId, messageId, text) {
			await bot.api.editMessageText(chatId, messageId, text);
		},
	};
}
