import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createRateLimiter,
	createTravelpayoutsClient,
	parsePricesResponse,
} from "../src/clients/travelpayouts.js";

const fixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/travelpayouts_prices_for_dates.json", import.meta.url),
		"utf8",
	),
);

describe("parsePricesResponse", () => {
	it("maps a real-shaped response to normalized quotes", () => {
		const quotes = parsePricesResponse(fixture);
		// The 4th fixture entry has no price and must be skipped.
		expect(quotes).toEqual([
			{
				depart_date: "2026-07-12",
				return_date: "2026-07-28",
				price_usd: 689,
				airline: "IB",
				direct: true,
			},
			{
				depart_date: "2026-07-19",
				return_date: "2026-08-02",
				price_usd: 712,
				airline: "UX",
				direct: false,
			},
			{
				depart_date: "2026-07-05",
				return_date: null,
				price_usd: 645,
				airline: "AR",
				direct: true,
			},
		]);
	});

	it("returns [] for an empty data array (rarely-searched route)", () => {
		expect(
			parsePricesResponse({ success: true, data: [], currency: "usd" }),
		).toEqual([]);
	});

	it("throws on success=false", () => {
		expect(() => parsePricesResponse({ success: false, data: [] })).toThrow(
			/success=false/,
		);
	});

	it("throws on an unexpected envelope", () => {
		expect(() => parsePricesResponse({ error: "nope" })).toThrow(
			/unexpected response shape/,
		);
	});
});

describe("createRateLimiter", () => {
	it("does not delay the first request and spaces the rest", async () => {
		const sleeps: number[] = [];
		const acquire = createRateLimiter(300, async (ms) => {
			sleeps.push(ms);
		});
		await acquire();
		await acquire();
		await acquire();
		expect(sleeps.length).toBe(2);
		// 300 req/min = one slot every 200ms.
		for (const ms of sleeps) {
			expect(ms).toBeGreaterThan(0);
			expect(ms).toBeLessThanOrEqual(400);
		}
	});
});

interface FetchCall {
	url: string;
	headers: Record<string, string>;
}

function clientWithResponses(responses: Response[]) {
	const calls: FetchCall[] = [];
	const sleeps: number[] = [];
	let next = 0;
	const fetchImpl = (async (
		url: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		const response = responses[next];
		next = Math.min(next + 1, responses.length - 1);
		if (!response) throw new Error("no stubbed response left");
		return response;
	}) as typeof fetch;
	const client = createTravelpayoutsClient("test-token", {
		fetchImpl,
		// requestsPerMinute huge so limiter pauses are ~0 and easy to filter.
		requestsPerMinute: 60_000_000,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return { client, calls, sleeps };
}

const okResponse = () =>
	new Response(JSON.stringify(fixture), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

describe("createTravelpayoutsClient", () => {
	it("builds the monthly query and sends the token header", async () => {
		const { client, calls } = clientWithResponses([okResponse()]);
		const quotes = await client.monthlyPrices("EZE", "MAD", "2026-07");
		expect(quotes.length).toBe(3);
		const url = new URL(calls[0]!.url);
		expect(url.searchParams.get("origin")).toBe("EZE");
		expect(url.searchParams.get("destination")).toBe("MAD");
		expect(url.searchParams.get("departure_at")).toBe("2026-07");
		expect(url.searchParams.get("currency")).toBe("usd");
		expect(url.searchParams.get("one_way")).toBe("false");
		expect(url.searchParams.get("limit")).toBe("30");
		expect(calls[0]!.headers["X-Access-Token"]).toBe("test-token");
	});

	it("on 429 sleeps until the advertised reset and retries", async () => {
		const { client, calls, sleeps } = clientWithResponses([
			new Response("", {
				status: 429,
				headers: { "x-rate-limit-reset": "7" },
			}),
			okResponse(),
		]);
		const quotes = await client.monthlyPrices("EZE", "MAD", "2026-07");
		expect(quotes.length).toBe(3);
		expect(calls.length).toBe(2);
		expect(sleeps).toContain(7000);
	});

	it("retries 5xx with backoff and gives up after max retries", async () => {
		const { client, calls } = clientWithResponses([
			new Response("", { status: 503 }),
		]);
		await expect(client.monthlyPrices("EZE", "MAD", "2026-07")).rejects.toThrow(
			/HTTP 503 after 3 retries/,
		);
		expect(calls.length).toBe(4); // initial attempt + 3 retries
	});

	it("does not retry non-retryable 4xx", async () => {
		const { client, calls } = clientWithResponses([
			new Response("", { status: 403 }),
		]);
		await expect(client.monthlyPrices("EZE", "MAD", "2026-07")).rejects.toThrow(
			/HTTP 403/,
		);
		expect(calls.length).toBe(1);
	});

	it("retries network failures and eventually succeeds", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("socket hang up");
			return okResponse();
		}) as typeof fetch;
		const client = createTravelpayoutsClient("test-token", {
			fetchImpl,
			requestsPerMinute: 60_000_000,
			sleep: async () => {},
		});
		const quotes = await client.monthlyPrices("EZE", "MAD", "2026-07");
		expect(quotes.length).toBe(3);
		expect(attempts).toBe(2);
	});
});
