import { z } from "zod";

/**
 * Layer 1 client: Travelpayouts Data API v3 (prices_for_dates).
 * Prices come from the Aviasales user-search cache (up to 7 days old).
 * They are never live prices — this layer only feeds candidate detection.
 */

const API_URL = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";

// Endpoint allows ~600 req/min; stay conservative.
const DEFAULT_REQUESTS_PER_MINUTE = 300;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
// Fallback wait on 429 when the reset header is missing or unparseable.
const DEFAULT_RATE_LIMIT_WAIT_MS = 10_000;
const MAX_RATE_LIMIT_WAIT_MS = 90_000;

/** One cached price observation, normalized for price_history. */
export interface PriceQuote {
	depart_date: string;
	return_date: string | null;
	price_usd: number;
	airline: string | null;
	direct: boolean | null;
}

export interface TravelpayoutsClient {
	/** Cheapest cached prices for a route in a given month (YYYY-MM). */
	monthlyPrices(
		origin: string,
		destination: string,
		month: string,
	): Promise<PriceQuote[]>;
}

const startsWithIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}/.test(value);

const ticketSchema = z.looseObject({
	price: z.number().positive(),
	departure_at: z.string().refine(startsWithIsoDate),
	return_at: z.string().refine(startsWithIsoDate).optional(),
	airline: z.string().optional(),
	transfers: z.number().int().nonnegative().optional(),
	return_transfers: z.number().int().nonnegative().optional(),
});

const envelopeSchema = z.looseObject({
	success: z.boolean(),
	data: z.array(z.unknown()),
});

/**
 * Parses a prices_for_dates response body into normalized quotes.
 * Individual malformed entries are skipped (the sweep must go on);
 * an unexpected envelope or success=false throws.
 */
export function parsePricesResponse(body: unknown): PriceQuote[] {
	const envelope = envelopeSchema.safeParse(body);
	if (!envelope.success) {
		throw new Error("travelpayouts: unexpected response shape");
	}
	if (!envelope.data.success) {
		throw new Error("travelpayouts: response reported success=false");
	}
	const quotes: PriceQuote[] = [];
	for (const entry of envelope.data.data) {
		const ticket = ticketSchema.safeParse(entry);
		if (!ticket.success) continue;
		const t = ticket.data;
		quotes.push({
			depart_date: t.departure_at.slice(0, 10),
			return_date: t.return_at ? t.return_at.slice(0, 10) : null,
			price_usd: t.price,
			airline: t.airline ?? null,
			// "direct" means no transfers on either leg.
			direct:
				t.transfers === undefined
					? null
					: t.transfers === 0 && (t.return_transfers ?? 0) === 0,
		});
	}
	return quotes;
}

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serial limiter: spaces request starts evenly so we never exceed
 * requestsPerMinute. Returns an acquire() that resolves when it is
 * safe to fire the next request.
 */
export function createRateLimiter(
	requestsPerMinute: number,
	sleep: Sleep = defaultSleep,
): () => Promise<void> {
	const intervalMs = 60_000 / requestsPerMinute;
	let nextSlot = 0;
	return async () => {
		const now = Date.now();
		const wait = nextSlot - now;
		nextSlot = Math.max(now, nextSlot) + intervalMs;
		if (wait > 0) await sleep(wait);
	};
}

/** Wait suggested by a 429: epoch seconds or delta seconds, clamped. */
function rateLimitDelayMs(headers: Headers): number {
	const reset = Number(headers.get("x-rate-limit-reset"));
	if (!Number.isFinite(reset) || reset <= 0) {
		return DEFAULT_RATE_LIMIT_WAIT_MS;
	}
	const ms = reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000;
	return Math.min(Math.max(ms, 1000), MAX_RATE_LIMIT_WAIT_MS);
}

export interface TravelpayoutsClientOptions {
	fetchImpl?: typeof fetch;
	sleep?: Sleep;
	requestsPerMinute?: number;
	timeoutMs?: number;
	maxRetries?: number;
}

export function createTravelpayoutsClient(
	token: string,
	options: TravelpayoutsClientOptions = {},
): TravelpayoutsClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const sleep = options.sleep ?? defaultSleep;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const acquire = createRateLimiter(
		options.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE,
		sleep,
	);

	async function request(url: string): Promise<PriceQuote[]> {
		for (let attempt = 0; ; attempt++) {
			await acquire();
			let response: Response;
			try {
				response = await fetchImpl(url, {
					headers: { "X-Access-Token": token },
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (error) {
				// Network failure or timeout: retry with backoff.
				if (attempt >= maxRetries) {
					throw new Error(
						`travelpayouts: request failed after ${attempt} retries: ${String(error)}`,
					);
				}
				await sleep(BACKOFF_BASE_MS * 2 ** attempt);
				continue;
			}

			if (response.status === 429) {
				if (attempt >= maxRetries) {
					throw new Error(
						`travelpayouts: still rate limited after ${attempt} retries`,
					);
				}
				await sleep(rateLimitDelayMs(response.headers));
				continue;
			}
			if (response.status >= 500) {
				if (attempt >= maxRetries) {
					throw new Error(
						`travelpayouts: HTTP ${response.status} after ${attempt} retries`,
					);
				}
				await sleep(BACKOFF_BASE_MS * 2 ** attempt);
				continue;
			}
			if (!response.ok) {
				throw new Error(`travelpayouts: HTTP ${response.status}`);
			}

			const quotes = parsePricesResponse(await response.json());
			// Quota exhausted but request succeeded: pause before the next one.
			if (response.headers.get("x-rate-limit-remaining") === "0") {
				await sleep(rateLimitDelayMs(response.headers));
			}
			return quotes;
		}
	}

	return {
		monthlyPrices(origin, destination, month) {
			const params = new URLSearchParams({
				origin,
				destination,
				departure_at: month,
				currency: "usd",
				one_way: "false",
				limit: "30",
			});
			return request(`${API_URL}?${params}`);
		},
	};
}
