import {
	Airport,
	FlightSearchFilters,
	FlightSegment,
	MaxStops,
	SearchFlights,
	SeatType,
	SortBy,
	TripType,
} from "fli-js";

/**
 * Spike (no integration): can fli-js — reverse-engineered Google Flights
 * access — return live prices from a GitHub Actions runner? Datacenter
 * IPs are the decisive risk before considering it as a verify provider.
 * Run locally first, then 2-3 times via the fli-spike workflow.
 */

const ROUTES: [string, string][] = [
	["EZE", "MAD"],
	["EZE", "MIA"],
	["AEP", "SCL"],
	["EZE", "GRU"],
	["EZE", "JFK"],
];

const PAUSE_MS = 2_000;

function isoDatePlus(days: number): string {
	return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function airport(code: string): Airport {
	const value = Airport[code as keyof typeof Airport];
	if (value === undefined) {
		throw new Error(`unknown airport code: ${code}`);
	}
	return value;
}

interface RouteOutcome {
	route: string;
	ok: boolean;
	detail: string;
}

async function spikeRoute(
	origin: string,
	dest: string,
	travelDate: string,
): Promise<RouteOutcome> {
	const route = `${origin}-${dest}`;
	const filters = new FlightSearchFilters({
		passenger_info: {
			adults: 1,
			children: 0,
			infants_in_seat: 0,
			infants_on_lap: 0,
		},
		flight_segments: [
			new FlightSegment({
				departure_airport: [[[airport(origin), 0]]],
				arrival_airport: [[[airport(dest), 0]]],
				travel_date: travelDate,
			}),
		],
		trip_type: TripType.ONE_WAY,
		seat_type: SeatType.ECONOMY,
		stops: MaxStops.ANY,
		sort_by: SortBy.CHEAPEST,
	});

	try {
		const results = await new SearchFlights().search(filters, {
			currency: "USD",
		});
		const flat = (results ?? []).flat();
		const priced = flat.filter((f) => f.price !== null);
		if (priced.length === 0) {
			return {
				route,
				ok: false,
				detail: `no priced results (${flat.length} rows)`,
			};
		}
		const cheapest = priced.reduce((a, b) =>
			(b.price as number) < (a.price as number) ? b : a,
		);
		const airline = cheapest.legs[0]?.airline ?? "?";
		return {
			route,
			ok: true,
			detail:
				`USD ${cheapest.price} · ${airline} · ` +
				`${cheapest.stops === 0 ? "nonstop" : `${cheapest.stops} stop(s)`} · ` +
				`${priced.length} priced options`,
		};
	} catch (error) {
		return { route, ok: false, detail: `ERROR: ${String(error)}` };
	}
}

async function main(): Promise<void> {
	const travelDate = isoDatePlus(30);
	console.log(`fli spike: one-way searches for ${travelDate}, currency USD`);

	const outcomes: RouteOutcome[] = [];
	for (const [origin, dest] of ROUTES) {
		const outcome = await spikeRoute(origin, dest, travelDate);
		outcomes.push(outcome);
		console.log(
			`${outcome.ok ? "OK " : "FAIL"} ${outcome.route}: ${outcome.detail}`,
		);
		await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
	}

	const okCount = outcomes.filter((o) => o.ok).length;
	console.log(
		`fli spike: ${okCount}/${outcomes.length} routes returned live prices`,
	);
	if (okCount === 0) {
		console.log(
			"fli spike: total failure — likely blocked from this IP or wire format changed",
		);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
