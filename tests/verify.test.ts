import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFallbackVerifier } from "../src/clients/fallbackVerifier.js";
import {
	createSearchApiVerifier,
	createVerifier,
	googleFlightsUrl,
	parseSearchApiResponse,
	type VerificationResult,
} from "../src/clients/flightVerifier.js";
import type {
	CandidateWithRoute,
	Deal,
	DealPatch,
	DealStatus,
} from "../src/db/queries.js";
import { runVerify } from "../src/pipeline/verify.js";

const fixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/searchapi_google_flights.json", import.meta.url),
		"utf8",
	),
);

describe("parseSearchApiResponse", () => {
	it("picks the cheapest option across best and other flights", () => {
		const result = parseSearchApiResponse(fixture);
		expect(result.alive).toBe(true);
		// $941 LATAM with a layover beats $968 Iberia nonstop.
		expect(result.priceUsd).toBe(941);
		expect(result.airline).toBe("LATAM");
		expect(result.direct).toBe(false);
		expect(result.bookingUrl).toContain("google.com/travel/flights");
	});

	it("reports a dead fare when there are no priced options", () => {
		expect(
			parseSearchApiResponse({ best_flights: [], other_flights: [] }),
		).toEqual({ alive: false });
		expect(parseSearchApiResponse({})).toEqual({ alive: false });
	});

	it("throws on a non-object body", () => {
		expect(() => parseSearchApiResponse("garbage")).toThrow(
			/unexpected response shape/,
		);
	});

	it("treats SearchApi's 200 + no-results error as a dead fare", () => {
		// Observed live: HTTP 200 with only an error string when Google
		// Flights cannot build the itinerary.
		expect(
			parseSearchApiResponse({
				search_metadata: { status: "Success" },
				error: "Google Flights didn't return any results.",
			}),
		).toEqual({ alive: false });
	});

	it("throws on an unknown 200 + error body so the deal stays candidate", () => {
		expect(() =>
			parseSearchApiResponse({ error: "You have exceeded your plan quota." }),
		).toThrow(/provider error/);
	});
});

describe("createSearchApiVerifier", () => {
	it("sends the search request with bearer auth and parses the result", async () => {
		const calls: { url: string; auth: string | undefined }[] = [];
		const fetchImpl = (async (
			url: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			calls.push({
				url: String(url),
				auth: (init?.headers as Record<string, string>).Authorization,
			});
			return new Response(JSON.stringify(fixture), { status: 200 });
		}) as typeof fetch;

		const verifier = createSearchApiVerifier("key-1", { fetchImpl });
		const result = await verifier.verify(
			"AEP",
			"MAD",
			"2026-08-19",
			"2026-09-08",
		);
		expect(result.priceUsd).toBe(941);
		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("engine")).toBe("google_flights");
		expect(url.searchParams.get("departure_id")).toBe("AEP");
		expect(url.searchParams.get("arrival_id")).toBe("MAD");
		expect(url.searchParams.get("outbound_date")).toBe("2026-08-19");
		expect(url.searchParams.get("return_date")).toBe("2026-09-08");
		expect(url.searchParams.get("currency")).toBe("USD");
		expect(calls[0]?.auth).toBe("Bearer key-1");
	});

	it("marks one-way searches and falls back to a constructed booking url", async () => {
		const fetchImpl = (async () =>
			new Response(
				JSON.stringify({
					best_flights: [{ price: 200, flights: [{ airline: "AR" }] }],
				}),
				{ status: 200 },
			)) as typeof fetch;
		const verifier = createSearchApiVerifier("key-1", { fetchImpl });
		const result = await verifier.verify("EZE", "SCL", "2026-07-01");
		expect(result.bookingUrl).toBe(
			googleFlightsUrl("EZE", "SCL", "2026-07-01"),
		);
	});

	it("retries 429 and gives up after max retries", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts += 1;
			return new Response("", { status: 429 });
		}) as typeof fetch;
		const verifier = createSearchApiVerifier("key-1", {
			fetchImpl,
			sleep: async () => {},
		});
		await expect(verifier.verify("EZE", "MAD", "2026-07-01")).rejects.toThrow(
			/HTTP 429 after 3 retries/,
		);
		expect(attempts).toBe(4);
	});

	it("does not retry a 401", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts += 1;
			return new Response("", { status: 401 });
		}) as typeof fetch;
		const verifier = createSearchApiVerifier("bad-key", { fetchImpl });
		await expect(verifier.verify("EZE", "MAD", "2026-07-01")).rejects.toThrow(
			/HTTP 401/,
		);
		expect(attempts).toBe(1);
	});
});

describe("createVerifier", () => {
	it("requires the matching key", () => {
		expect(() => createVerifier("searchapi", {})).toThrow(/SEARCHAPI_KEY/);
	});

	it("keeps flightapi as an explicit unimplemented skeleton", () => {
		expect(() => createVerifier("flightapi", { flightApiKey: "k" })).toThrow(
			/not implemented/,
		);
	});
});

describe("runVerify", () => {
	let dealSeq = 0;
	function candidate(
		cachedPrice: number,
		overrides: Partial<CandidateWithRoute> = {},
	): CandidateWithRoute {
		dealSeq += 1;
		return {
			id: `deal-${dealSeq}`,
			route_id: 1,
			status: "candidate",
			depart_date: "2026-08-19",
			return_date: "2026-09-08",
			cached_price_usd: cachedPrice,
			verified_price_usd: null,
			airline: "IB",
			direct: null,
			booking_url: null,
			median_at_detection: 1404,
			discount_pct: 0.35,
			score: 50,
			is_error_fare: false,
			detected_at: "2026-06-12T10:00:00Z",
			verified_at: null,
			published_at: null,
			expired_at: null,
			telegram_message_id: null,
			rejection_reason: null,
			routes: { origin: "AEP", destination: "MAD" },
			...overrides,
		};
	}

	function harness(
		candidates: CandidateWithRoute[],
		results: (VerificationResult | Error)[],
	) {
		const transitions: {
			id: string;
			status: DealStatus;
			patch: DealPatch | undefined;
		}[] = [];
		const verifyCalls: string[] = [];
		const logs: string[] = [];
		let call = 0;
		const deps = {
			db: {
				getTopCandidates: async (limit: number) => candidates.slice(0, limit),
				transitionDeal: async (
					id: string,
					status: DealStatus,
					patch?: DealPatch,
				) => {
					transitions.push({ id, status, patch });
					return { id } as Deal;
				},
			},
			verifier: {
				verify: async (origin: string, dest: string, depart: string) => {
					verifyCalls.push(`${origin}-${dest}:${depart}`);
					const result = results[Math.min(call, results.length - 1)];
					call += 1;
					if (result instanceof Error) throw result;
					return result as VerificationResult;
				},
			},
			candidateLimit: 2,
			budget: 2,
			log: (line: string) => logs.push(line),
		};
		return { deps, transitions, verifyCalls, logs };
	}

	const liveOk: VerificationResult = {
		alive: true,
		priceUsd: 941,
		airline: "LATAM",
		direct: false,
		bookingUrl: "https://www.google.com/travel/flights?tfs=abc",
	};

	it("confirms a deal within the 15% tolerance and stores the live data", async () => {
		const { deps, transitions } = harness([candidate(913)], [liveOk]);
		const summary = await runVerify(deps);
		expect(summary.confirmed).toBe(1);
		expect(transitions).toEqual([
			{
				id: "deal-1",
				status: "verified",
				patch: {
					verified_price_usd: 941,
					booking_url: "https://www.google.com/travel/flights?tfs=abc",
					airline: "LATAM",
					direct: false,
				},
			},
		]);
	});

	it("rejects when the live price exceeds tolerance", async () => {
		const { deps, transitions } = harness(
			[candidate(700)],
			[{ alive: true, priceUsd: 941 }],
		);
		const summary = await runVerify(deps);
		expect(summary.rejected).toBe(1);
		expect(transitions[0]?.status).toBe("rejected");
		expect(transitions[0]?.patch).toEqual({ rejection_reason: "price_gone" });
	});

	it("rejects when the fare is gone entirely", async () => {
		const { deps, transitions } = harness([candidate(700)], [{ alive: false }]);
		await runVerify(deps);
		expect(transitions[0]?.status).toBe("rejected");
	});

	it("leaves the deal as candidate on provider error", async () => {
		const { deps, transitions, logs } = harness(
			[candidate(700)],
			[new Error("searchapi: HTTP 503 after 3 retries")],
		);
		const summary = await runVerify(deps);
		expect(summary.errors).toBe(1);
		expect(transitions).toEqual([]);
		expect(
			logs.some((line) => line.includes("nothing will be published")),
		).toBe(true);
	});

	it("never spends more paid calls than the budget", async () => {
		const many = [candidate(913), candidate(913), candidate(913)];
		const { deps, verifyCalls } = harness(many, [liveOk]);
		const summary = await runVerify(deps);
		expect(verifyCalls.length).toBe(2);
		expect(summary.paidCalls).toBe(2);
		expect(summary.budget).toBe(2);
	});

	// --- fli provider: free primary + paid SearchApi fallback ---

	/**
	 * Builds runVerify deps wired like the fli provider: a scripted primary
	 * (one behaviour per verify call), no paid fallback by default, and a high
	 * candidateLimit decoupled from the paid budget.
	 */
	function fliHarness(
		candidates: CandidateWithRoute[],
		primaryScript: (VerificationResult | Error)[],
		opts: { fallback?: VerificationResult | Error; budget?: number } = {},
	) {
		const transitions: { id: string; status: DealStatus }[] = [];
		const operatorAlerts: string[] = [];
		let call = 0;
		const primary = {
			async verify() {
				const step = primaryScript[Math.min(call, primaryScript.length - 1)];
				call += 1;
				if (step instanceof Error) throw step;
				return step as VerificationResult;
			},
		};
		const fallback =
			opts.fallback === undefined
				? null
				: {
						async verify() {
							if (opts.fallback instanceof Error) throw opts.fallback;
							return opts.fallback as VerificationResult;
						},
					};
		const verifier = createFallbackVerifier(
			primary,
			fallback,
			opts.budget ?? 0,
			() => {},
		);
		const deps = {
			db: {
				getTopCandidates: async (limit: number) => candidates.slice(0, limit),
				transitionDeal: async (id: string, status: DealStatus) => {
					transitions.push({ id, status });
					return { id } as Deal;
				},
			},
			verifier,
			candidateLimit: 50,
			budget: opts.budget ?? 0,
			notifyOperator: async (text: string) => {
				operatorAlerts.push(text);
			},
			log: () => {},
		};
		return { deps, verifier, transitions, operatorAlerts };
	}

	it("verifies far more candidates than the paid budget when free", async () => {
		const candidates = Array.from({ length: 5 }, () => candidate(913));
		const { deps, verifier, transitions, operatorAlerts } = fliHarness(
			candidates,
			[liveOk],
		);
		const summary = await runVerify(deps);
		expect(summary.confirmed).toBe(5);
		expect(summary.paidCalls).toBe(0);
		expect(verifier.stats.primaryCalls).toBe(5);
		expect(transitions).toHaveLength(5);
		expect(operatorAlerts).toEqual([]);
	});

	it("retries an errored candidate with fli before giving up", async () => {
		// First verify throws; the end-of-run primary-only retry succeeds.
		const { deps, transitions } = fliHarness(
			[candidate(913)],
			[new Error("fli: transient"), liveOk],
		);
		const summary = await runVerify(deps);
		expect(summary.errors).toBe(0);
		expect(summary.confirmed).toBe(1);
		expect(transitions).toHaveLength(1);
		expect(transitions[0]?.status).toBe("verified");
	});

	it("alerts the operator when fli collapses on every call", async () => {
		const { deps, operatorAlerts } = fliHarness(
			[candidate(913), candidate(913)],
			[new Error("fli: blocked")],
		);
		const summary = await runVerify(deps);
		expect(summary.confirmed).toBe(0);
		expect(summary.errors).toBe(2);
		expect(operatorAlerts).toHaveLength(1);
		expect(operatorAlerts[0]).toMatch(/CAÍDO/);
	});
});
