import { z } from "zod";
import { createFallbackVerifier } from "./fallbackVerifier.js";
import { createFliVerifier } from "./fliVerifier.js";

/**
 * Layer 3: real-time price verification behind a provider-agnostic
 * interface. Every call here costs money (or free-tier quota) — callers
 * must budget via MAX_VERIFICATIONS_PER_RUN.
 */

export interface VerificationResult {
	alive: boolean;
	priceUsd?: number;
	airline?: string;
	direct?: boolean;
	/** Deep link to Google Flights with the search prefilled. */
	bookingUrl?: string;
	availableDates?: string[];
}

export interface FlightVerifier {
	verify(
		origin: string,
		dest: string,
		departDate: string,
		returnDate?: string,
	): Promise<VerificationResult>;
}

const SEARCHAPI_URL = "https://www.searchapi.io/api/v1/search";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;

const legSchema = z.looseObject({
	airline: z.string().optional(),
});

const optionSchema = z.looseObject({
	price: z.number().positive().optional(),
	flights: z.array(legSchema).optional(),
});

const responseSchema = z.looseObject({
	best_flights: z.array(optionSchema).optional(),
	other_flights: z.array(optionSchema).optional(),
	search_metadata: z
		.looseObject({ google_flights_url: z.string().optional() })
		.optional(),
	// SearchApi reports some failures as HTTP 200 + error string.
	error: z.string().optional(),
});

/** 200-with-error body that legitimately means "this fare is gone". */
const NO_RESULTS_ERROR = /didn't return any results/i;

/** Fallback when the provider returns no deep link. */
export function googleFlightsUrl(
	origin: string,
	dest: string,
	departDate: string,
): string {
	const query = encodeURIComponent(
		`Flights from ${origin} to ${dest} on ${departDate}`,
	);
	return `https://www.google.com/travel/flights?q=${query}`;
}

/**
 * Maps a SearchApi google_flights response to a VerificationResult:
 * the cheapest priced option across best_flights + other_flights.
 * No priced options means the fare is gone (alive=false).
 */
export function parseSearchApiResponse(body: unknown): VerificationResult {
	const parsed = responseSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error("searchapi: unexpected response shape");
	}
	if (parsed.data.error !== undefined) {
		if (NO_RESULTS_ERROR.test(parsed.data.error)) {
			return { alive: false };
		}
		// Unknown provider error: must throw so the deal stays candidate
		// instead of being wrongly rejected as price_gone.
		throw new Error(`searchapi: provider error: ${parsed.data.error}`);
	}
	const options = [
		...(parsed.data.best_flights ?? []),
		...(parsed.data.other_flights ?? []),
	].filter((option) => option.price !== undefined);
	if (options.length === 0) {
		return { alive: false };
	}
	const cheapest = options.reduce((a, b) =>
		(b.price as number) < (a.price as number) ? b : a,
	);
	const legs = cheapest.flights ?? [];
	const result: VerificationResult = {
		alive: true,
		priceUsd: cheapest.price as number,
	};
	const airline = legs[0]?.airline;
	if (airline !== undefined) result.airline = airline;
	// One leg on the outbound itinerary means nonstop.
	if (legs.length > 0) result.direct = legs.length === 1;
	const deepLink = parsed.data.search_metadata?.google_flights_url;
	if (deepLink !== undefined) result.bookingUrl = deepLink;
	return result;
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export interface SearchApiVerifierOptions {
	fetchImpl?: typeof fetch;
	sleep?: Sleep;
	timeoutMs?: number;
	maxRetries?: number;
}

export function createSearchApiVerifier(
	apiKey: string,
	options: SearchApiVerifierOptions = {},
): FlightVerifier {
	const fetchImpl = options.fetchImpl ?? fetch;
	const sleep = options.sleep ?? defaultSleep;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

	return {
		async verify(origin, dest, departDate, returnDate) {
			const params = new URLSearchParams({
				engine: "google_flights",
				departure_id: origin,
				arrival_id: dest,
				outbound_date: departDate,
				currency: "USD",
			});
			if (returnDate) {
				params.set("return_date", returnDate);
			} else {
				params.set("flight_type", "one_way");
			}
			const url = `${SEARCHAPI_URL}?${params}`;

			for (let attempt = 0; ; attempt++) {
				try {
					const response = await fetchImpl(url, {
						headers: { Authorization: `Bearer ${apiKey}` },
						signal: AbortSignal.timeout(timeoutMs),
					});
					if (response.status === 429 || response.status >= 500) {
						if (attempt >= maxRetries) {
							throw new Error(
								`searchapi: HTTP ${response.status} after ${attempt} retries`,
							);
						}
						await sleep(BACKOFF_BASE_MS * 2 ** attempt);
						continue;
					}
					if (!response.ok) {
						throw new Error(`searchapi: HTTP ${response.status}`);
					}
					const result = parseSearchApiResponse(await response.json());
					if (!result.bookingUrl) {
						result.bookingUrl = googleFlightsUrl(origin, dest, departDate);
					}
					return result;
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.startsWith("searchapi:")
					) {
						throw error;
					}
					if (attempt >= maxRetries) {
						throw new Error(
							`searchapi: request failed after ${attempt} retries: ${String(error)}`,
						);
					}
					await sleep(BACKOFF_BASE_MS * 2 ** attempt);
				}
			}
		},
	};
}

export type VerifierProvider = "searchapi" | "flightapi" | "fli";

export interface CreateVerifierOptions {
	/** Paid-call cap for the SearchApi fallback when provider is "fli". */
	fallbackBudget?: number;
	log?: (line: string) => void;
}

export function createVerifier(
	provider: VerifierProvider,
	keys: { searchApiKey?: string; flightApiKey?: string },
	options: CreateVerifierOptions = {},
): FlightVerifier {
	if (provider === "searchapi") {
		if (!keys.searchApiKey) {
			throw new Error("SEARCHAPI_KEY is required for the searchapi verifier");
		}
		return createSearchApiVerifier(keys.searchApiKey);
	}
	if (provider === "fli") {
		// fli is free and primary; SearchApi (when keyed) is the paid fallback
		// for the calls fli can't serve. With no key, fli runs solo — still
		// fail-safe, since a fli error just leaves the deal unverified.
		const fallback = keys.searchApiKey
			? createSearchApiVerifier(keys.searchApiKey)
			: null;
		return createFallbackVerifier(
			createFliVerifier(),
			fallback,
			options.fallbackBudget ?? 0,
			options.log,
		);
	}
	// Skeleton kept on purpose: the interface is the contract, the provider
	// is swappable without touching pipeline logic.
	throw new Error("flightapi verifier not implemented yet");
}
