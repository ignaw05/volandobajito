import {
	Airport,
	type FlightResult,
	FlightSearchFilters,
	FlightSegment,
	MaxStops,
	SearchFlights,
	SeatType,
	SortBy,
	TripType,
} from "fli-js";
import {
	type FlightVerifier,
	googleFlightsUrl,
	type VerificationResult,
} from "./flightVerifier.js";

/**
 * Layer 3 verifier backed by fli-js — reverse-engineered Google Flights
 * access (free, no key). Same contract as the SearchApi verifier: returns
 * the cheapest priced itinerary, `alive: false` when no fare is priced, and
 * THROWS on any provider failure so the caller can fall back / retry. The
 * fli-spike experiment (see README) confirmed Actions runner IPs are served.
 *
 * Round-trips select the single cheapest outbound (`topN: 1`) and read its
 * return total — two fetches, not the full multi-leg fan-out — keeping the
 * request count (and block risk) close to a one-way search.
 */

const PASSENGER_INFO = {
	adults: 1,
	children: 0,
	infants_in_seat: 0,
	infants_on_lap: 0,
} as const;

function airport(code: string): Airport {
	const value = Airport[code as keyof typeof Airport];
	if (value === undefined) {
		throw new Error(`fli: unknown airport code ${code}`);
	}
	return value;
}

function buildFilters(
	origin: string,
	dest: string,
	departDate: string,
	returnDate?: string,
): FlightSearchFilters {
	const segments = [
		new FlightSegment({
			departure_airport: [[[airport(origin), 0]]],
			arrival_airport: [[[airport(dest), 0]]],
			travel_date: departDate,
		}),
	];
	if (returnDate) {
		segments.push(
			new FlightSegment({
				departure_airport: [[[airport(dest), 0]]],
				arrival_airport: [[[airport(origin), 0]]],
				travel_date: returnDate,
			}),
		);
	}
	return new FlightSearchFilters({
		passenger_info: { ...PASSENGER_INFO },
		flight_segments: segments,
		trip_type: returnDate ? TripType.ROUND_TRIP : TripType.ONE_WAY,
		seat_type: SeatType.ECONOMY,
		stops: MaxStops.ANY,
		sort_by: SortBy.CHEAPEST,
	});
}

type Entry = FlightResult | FlightResult[];

/** Outbound (first) leg-set of an itinerary; the whole result when one-way. */
function outbound(entry: Entry): FlightResult | undefined {
	return Array.isArray(entry) ? entry[0] : entry;
}

/**
 * Total fare for an itinerary. For a round-trip combo the trailing result
 * (the return, fetched after selecting the outbound) carries the cumulative
 * round-trip total; a one-way itinerary is a single result.
 */
function totalPrice(entry: Entry): number | null {
	const flights = Array.isArray(entry) ? entry : [entry];
	return flights[flights.length - 1]?.price ?? null;
}

export interface FliVerifierOptions {
	/** Injectable for tests; defaults to a real SearchFlights instance. */
	search?: Pick<SearchFlights, "search" | "buildFlightBookingUrl">;
}

export function createFliVerifier(
	options: FliVerifierOptions = {},
): FlightVerifier {
	const search = options.search ?? new SearchFlights();

	return {
		async verify(origin, dest, departDate, returnDate) {
			const filters = buildFilters(origin, dest, departDate, returnDate);
			// topN bounds the round-trip expansion to the cheapest outbound; it is
			// harmless for one-way (just caps how many rows we scan).
			const results = await search.search(filters, {
				currency: "USD",
				...(returnDate ? { topN: 1 } : {}),
			});

			const priced = (results ?? []).filter(
				(entry): entry is Entry => totalPrice(entry) !== null,
			);
			if (priced.length === 0) {
				return { alive: false };
			}

			const cheapest = priced.reduce((a, b) =>
				(totalPrice(b) as number) < (totalPrice(a) as number) ? b : a,
			);
			const lead = outbound(cheapest);
			const result: VerificationResult = {
				alive: true,
				priceUsd: totalPrice(cheapest) as number,
			};
			const airline = lead?.legs[0]?.airline;
			if (airline !== undefined) result.airline = String(airline);
			// A nonstop outbound has zero stops.
			if (lead !== undefined) result.direct = lead.stops === 0;
			result.bookingUrl =
				safeBookingUrl(search, cheapest) ??
				googleFlightsUrl(origin, dest, departDate);
			return result;
		},
	};
}

/** buildFlightBookingUrl never throws per its contract, but guard anyway. */
function safeBookingUrl(
	search: Pick<SearchFlights, "buildFlightBookingUrl">,
	entry: Entry,
): string | undefined {
	try {
		return search.buildFlightBookingUrl(entry, { currency: "USD" });
	} catch {
		return undefined;
	}
}
