import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Region = "regional" | "caribbean" | "usa" | "europe" | "other";

export type DealStatus =
	| "candidate"
	| "verified"
	| "rejected"
	| "published"
	| "expired";

export type PriceSource =
	| "travelpayouts"
	| "searchapi"
	| "flightapi"
	| "serpapi_bootstrap";

export interface Route {
	id: number;
	origin: string;
	destination: string;
	region: Region;
	active: boolean;
	sanity_threshold_usd: number | null;
	created_at: string;
}

export interface NewPriceObservation {
	route_id: number;
	depart_date: string;
	return_date: string | null;
	price_usd: number;
	airline: string | null;
	direct: boolean | null;
	source: PriceSource;
}

export interface RouteStats {
	route_id: number;
	median_usd: number | null;
	p10_usd: number | null;
	p25_usd: number | null;
	sample_count: number;
	window_days: number;
}

export interface PriceObservation extends NewPriceObservation {
	id: number;
	observed_at: string;
}

export interface NewDeal {
	route_id: number;
	depart_date: string;
	return_date: string | null;
	cached_price_usd: number;
	airline: string | null;
	direct: boolean | null;
	median_at_detection: number | null;
	discount_pct: number | null;
	score: number | null;
	is_error_fare: boolean;
}

export interface Deal extends NewDeal {
	id: string;
	status: DealStatus;
	verified_price_usd: number | null;
	booking_url: string | null;
	detected_at: string;
	verified_at: string | null;
	published_at: string | null;
	expired_at: string | null;
	telegram_message_id: number | null;
	rejection_reason: string | null;
}

/** Mutable deal fields that may accompany a status transition. */
export interface DealPatch {
	verified_price_usd?: number;
	airline?: string;
	direct?: boolean;
	booking_url?: string;
	telegram_message_id?: number;
	rejection_reason?: string;
}

export interface NewClickEvent {
	deal_id: string;
	user_agent: string | null;
	referer: string | null;
}

/** Column stamped automatically on each status transition. */
const STATUS_TIMESTAMP_COLUMN: Partial<Record<DealStatus, string>> = {
	verified: "verified_at",
	published: "published_at",
	expired: "expired_at",
};

export const INSERT_CHUNK_SIZE = 500;

interface DbResult<T> {
	data: T | null;
	error: { message: string } | null;
}

function unwrap<T>(result: DbResult<T>, context: string): T {
	if (result.error) {
		throw new Error(`${context}: ${result.error.message}`);
	}
	return result.data as T;
}

export function createSupabase(
	url: string,
	serviceRoleKey: string,
): SupabaseClient {
	return createClient(url, serviceRoleKey, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
}

export function createDb(supabase: SupabaseClient) {
	return {
		async getActiveRoutes(): Promise<Route[]> {
			const result = await supabase
				.from("routes")
				.select("*")
				.eq("active", true)
				.order("id");
			return unwrap(result, "getActiveRoutes") ?? [];
		},

		/** Batch insert of price observations, chunked to keep payloads bounded. */
		async insertPriceObservations(
			rows: NewPriceObservation[],
		): Promise<number> {
			for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
				const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
				const result = await supabase.from("price_history").insert(chunk);
				unwrap(result, `insertPriceObservations (chunk at ${i})`);
			}
			return rows.length;
		},

		/**
		 * Recomputes route_stats (median/p10/p25 via percentile_cont) over the
		 * trailing window, server-side. Returns the number of routes refreshed.
		 */
		async refreshRouteStats(windowDays = 90): Promise<number> {
			const result = await supabase.rpc("refresh_route_stats", {
				p_window_days: windowDays,
			});
			return unwrap(result as DbResult<number>, "refreshRouteStats");
		},

		async listRouteStats(): Promise<RouteStats[]> {
			const result = await supabase.from("route_stats").select("*");
			return unwrap(result, "listRouteStats") ?? [];
		},

		/**
		 * Layer-1 observations since a given instant (the latest scan run).
		 * Paginated: PostgREST caps responses at 1000 rows and a full sweep
		 * inserts ~2000.
		 */
		async getRecentObservations(sinceIso: string): Promise<PriceObservation[]> {
			const pageSize = 1000;
			const rows: PriceObservation[] = [];
			for (let from = 0; ; from += pageSize) {
				const result = await supabase
					.from("price_history")
					.select("*")
					.eq("source", "travelpayouts")
					.gte("observed_at", sinceIso)
					.order("id")
					.range(from, from + pageSize - 1);
				const page: PriceObservation[] =
					unwrap(result, "getRecentObservations") ?? [];
				rows.push(...page);
				if (page.length < pageSize) return rows;
			}
		},

		/**
		 * Route ids with a non-rejected deal detected since the given instant.
		 * Used for the 72h per-route cooldown.
		 */
		async getRoutesWithDealsSince(sinceIso: string): Promise<number[]> {
			const result = await supabase
				.from("deals")
				.select("route_id")
				.neq("status", "rejected")
				.gte("detected_at", sinceIso);
			const rows = unwrap(result, "getRoutesWithDealsSince") ?? [];
			return (rows as { route_id: number }[]).map((row) => row.route_id);
		},

		async createDeals(deals: NewDeal[]): Promise<number> {
			if (deals.length === 0) return 0;
			const result = await supabase.from("deals").insert(deals);
			unwrap(result, "createDeals");
			return deals.length;
		},

		async upsertRouteStats(stats: RouteStats[]): Promise<void> {
			const now = new Date().toISOString();
			const rows = stats.map((s) => ({ ...s, updated_at: now }));
			for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
				const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
				const result = await supabase
					.from("route_stats")
					.upsert(chunk, { onConflict: "route_id" });
				unwrap(result, `upsertRouteStats (chunk at ${i})`);
			}
		},

		async createDeal(deal: NewDeal): Promise<Deal> {
			const result = await supabase
				.from("deals")
				.insert(deal)
				.select()
				.single();
			return unwrap(result, "createDeal");
		},

		/**
		 * Moves a deal to a new status, stamping the matching timestamp column
		 * (verified_at / published_at / expired_at) and applying extra fields.
		 */
		async transitionDeal(
			id: string,
			status: DealStatus,
			patch: DealPatch = {},
		): Promise<Deal> {
			const update: Record<string, unknown> = { status, ...patch };
			const timestampColumn = STATUS_TIMESTAMP_COLUMN[status];
			if (timestampColumn) {
				update[timestampColumn] = new Date().toISOString();
			}
			const result = await supabase
				.from("deals")
				.update(update)
				.eq("id", id)
				.select()
				.single();
			return unwrap(result, `transitionDeal(${id} -> ${status})`);
		},

		async getDealsByStatus(status: DealStatus): Promise<Deal[]> {
			const result = await supabase
				.from("deals")
				.select("*")
				.eq("status", status)
				.order("detected_at", { ascending: false });
			return unwrap(result, `getDealsByStatus(${status})`) ?? [];
		},

		async recordClick(event: NewClickEvent): Promise<void> {
			const result = await supabase.from("click_events").insert(event);
			unwrap(result, "recordClick");
		},
	};
}

export type Db = ReturnType<typeof createDb>;
