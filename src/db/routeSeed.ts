import type { Region } from "./queries.js";

/**
 * Single source of truth for the monitored route universe.
 * migrations/002_route_seed.sql is generated from this file
 * (npm run seed-routes -- --sql).
 */

export const ORIGINS = ["EZE", "AEP", "COR", "MDZ", "ROS"] as const;

/** Absolute sanity threshold in USD per region. null = no absolute threshold. */
export const REGION_THRESHOLDS_USD: Record<Region, number | null> = {
	regional: 120,
	caribbean: 450,
	usa: 550,
	europe: 650,
	other: null,
};

const DESTINATIONS_BY_REGION: Record<Region, string[]> = {
	regional: [
		// Brazil
		"GRU",
		"GIG",
		"FLN",
		"SSA",
		"REC",
		"BSB",
		"CNF",
		"POA",
		"CWB",
		"FOR",
		"IGU",
		// Chile / Uruguay / Paraguay
		"SCL",
		"MVD",
		"PDP",
		"ASU",
		// Peru / Bolivia
		"LIM",
		"CUZ",
		"VVI",
		"LPB",
		// Colombia / Ecuador
		"BOG",
		"MDE",
		"CTG",
		"UIO",
		"GYE",
	],
	caribbean: [
		"CUN",
		"PUJ",
		"SDQ",
		"HAV",
		"VRA",
		"SJU",
		"AUA",
		"CUR",
		"MBJ",
		"NAS",
	],
	usa: [
		"MIA",
		"FLL",
		"MCO",
		"TPA",
		"JFK",
		"EWR",
		"BOS",
		"IAD",
		"ATL",
		"ORD",
		"DFW",
		"IAH",
		"DEN",
		"LAS",
		"LAX",
		"SFO",
		"SEA",
		"CLT",
	],
	europe: [
		"MAD",
		"BCN",
		"AGP",
		"PMI",
		"VLC",
		"LIS",
		"OPO",
		"FCO",
		"MXP",
		"VCE",
		"NAP",
		"CDG",
		"ORY",
		"NCE",
		"AMS",
		"LHR",
		"LGW",
		"FRA",
		"MUC",
		"BER",
		"ZRH",
		"VIE",
		"BRU",
		"DUB",
		"CPH",
		"ATH",
		"IST",
	],
	other: [
		"TLV",
		"AKL",
		"SYD",
		"DOH",
		"DXB",
		"JNB",
		"NRT",
		"ICN",
		"PVG",
		"HKG",
		"BKK",
		"SIN",
		"DEL",
		"CAI",
		"MEX",
		"SJO",
		"PTY",
	],
};

export interface SeedRoute {
	origin: string;
	destination: string;
	region: Region;
	sanity_threshold_usd: number | null;
}

export interface SeedDestination {
	destination: string;
	region: Region;
	sanity_threshold_usd: number | null;
}

export function seedDestinations(): SeedDestination[] {
	return (Object.keys(DESTINATIONS_BY_REGION) as Region[]).flatMap((region) =>
		DESTINATIONS_BY_REGION[region].map((destination) => ({
			destination,
			region,
			sanity_threshold_usd: REGION_THRESHOLDS_USD[region],
		})),
	);
}

/** Full cross product origins x destinations. */
export function expandRoutes(): SeedRoute[] {
	const destinations = seedDestinations();
	return ORIGINS.flatMap((origin) =>
		destinations.map((d) => ({ origin, ...d })),
	);
}

/** Plain-SQL version of the seed, for migrations applied via psql/SQL editor. */
export function seedRoutesSql(): string {
	const originValues = ORIGINS.map((o) => `('${o}')`).join(", ");
	const destinationValues = seedDestinations()
		.map(
			(d) =>
				`  ('${d.destination}', '${d.region}', ${d.sanity_threshold_usd ?? "null"})`,
		)
		.join(",\n");
	return [
		"-- 002_route_seed.sql",
		"-- Generated from src/db/routeSeed.ts - do not edit by hand.",
		"-- Regenerate with: npm run seed-routes -- --sql > migrations/002_route_seed.sql",
		"insert into routes (origin, destination, region, sanity_threshold_usd)",
		"select o.origin, d.destination, d.region, d.sanity_threshold_usd",
		`from (values ${originValues}) as o (origin)`,
		"cross join (values",
		destinationValues,
		") as d (destination, region, sanity_threshold_usd)",
		"on conflict (origin, destination) do nothing;",
		"",
	].join("\n");
}
