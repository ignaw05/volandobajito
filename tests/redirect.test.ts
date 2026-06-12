import { describe, expect, it } from "vitest";
import type { NewClickEvent } from "../src/db/queries.js";
import {
	type RedirectDeps,
	resolveRedirect,
} from "../src/redirect/redirect.js";

const DEAL_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_URL = "https://www.google.com/travel/flights?tfs=abc";
const META = { userAgent: "test-agent/1.0", referer: "https://t.me/canal" };

interface Harness {
	deps: RedirectDeps;
	lookups: string[];
	clicks: NewClickEvent[];
	background: Promise<unknown>[];
	logs: string[];
}

function harness(options: {
	bookingUrlsById?: Record<string, string | null>;
	lookupError?: Error;
	clickError?: Error;
	clickNeverSettles?: boolean;
}): Harness {
	const lookups: string[] = [];
	const clicks: NewClickEvent[] = [];
	const background: Promise<unknown>[] = [];
	const logs: string[] = [];
	const deps: RedirectDeps = {
		db: {
			getDealWithRouteById: async (id) => {
				lookups.push(id);
				if (options.lookupError) throw options.lookupError;
				const url = options.bookingUrlsById?.[id];
				return url === undefined ? null : { booking_url: url };
			},
			recordClick: (event) => {
				clicks.push(event);
				if (options.clickNeverSettles) return new Promise(() => {});
				if (options.clickError) return Promise.reject(options.clickError);
				return Promise.resolve();
			},
		},
		waitUntil: (work) => {
			background.push(work);
		},
		log: (line) => logs.push(line),
	};
	return { deps, lookups, clicks, background, logs };
}

describe("resolveRedirect", () => {
	it("302s to booking_url and records the click in the background", async () => {
		const h = harness({ bookingUrlsById: { [DEAL_ID]: BOOKING_URL } });
		const result = await resolveRedirect(h.deps, DEAL_ID, META);
		expect(result).toEqual({ kind: "redirect", location: BOOKING_URL });
		await Promise.all(h.background);
		expect(h.clicks).toEqual([
			{
				deal_id: DEAL_ID,
				user_agent: "test-agent/1.0",
				referer: "https://t.me/canal",
			},
		]);
	});

	it("responds without waiting for the click insert", async () => {
		const h = harness({
			bookingUrlsById: { [DEAL_ID]: BOOKING_URL },
			clickNeverSettles: true,
		});
		// If resolveRedirect awaited the insert, this would hang forever.
		const result = await resolveRedirect(h.deps, DEAL_ID, META);
		expect(result.kind).toBe("redirect");
		expect(h.clicks.length).toBe(1);
		expect(h.background.length).toBe(1);
	});

	it("still redirects when the click insert fails", async () => {
		const h = harness({
			bookingUrlsById: { [DEAL_ID]: BOOKING_URL },
			clickError: new Error("db down"),
		});
		const result = await resolveRedirect(h.deps, DEAL_ID, META);
		expect(result.kind).toBe("redirect");
		await Promise.all(h.background);
		expect(h.logs.some((line) => line.includes("recordClick failed"))).toBe(
			true,
		);
	});

	it("404s a missing deal without recording a click", async () => {
		const h = harness({});
		const result = await resolveRedirect(h.deps, DEAL_ID, META);
		expect(result).toEqual({ kind: "not_found" });
		expect(h.clicks).toEqual([]);
	});

	it("404s a malformed id without hitting the database", async () => {
		const h = harness({});
		const result = await resolveRedirect(h.deps, "'; drop table deals;", META);
		expect(result).toEqual({ kind: "not_found" });
		expect(h.lookups).toEqual([]);
	});

	it("404s a deal without booking_url", async () => {
		const h = harness({ bookingUrlsById: { [DEAL_ID]: null } });
		const result = await resolveRedirect(h.deps, DEAL_ID, META);
		expect(result).toEqual({ kind: "not_found" });
		expect(h.clicks).toEqual([]);
	});

	it("404s instead of throwing when the deal lookup fails", async () => {
		const h = harness({ lookupError: new Error("supabase unreachable") });
		const result = await resolveRedirect(h.deps, DEAL_ID, META);
		expect(result).toEqual({ kind: "not_found" });
		expect(h.logs.some((line) => line.includes("lookup failed"))).toBe(true);
	});
});
