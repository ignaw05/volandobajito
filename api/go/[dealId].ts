import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { waitUntil } from "@vercel/functions";
import { parseEnvSubset } from "../../src/config.js";
import { createDb, type Db } from "../../src/db/queries.js";
import { resolveRedirect } from "../../src/redirect/redirect.js";

/** Vercel's Node runtime parses route params and query into req.query. */
interface VercelLikeRequest extends IncomingMessage {
	query: Record<string, string | string[] | undefined>;
}

// Reused across warm invocations; created lazily so a misconfigured env
// fails per-request (500) instead of poisoning the module at import time.
let db: Db | null = null;

function getDb(): Db {
	if (db === null) {
		const config = parseEnvSubset(
			["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
			process.env,
		);
		db = createDb(
			createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
		);
	}
	return db;
}

function headerValue(req: IncomingMessage, name: string): string | null {
	const value = req.headers[name];
	if (Array.isArray(value)) return value[0] ?? null;
	return value ?? null;
}

export default async function handler(
	req: VercelLikeRequest,
	res: ServerResponse,
): Promise<void> {
	const rawDealId = req.query.dealId;
	const dealId = typeof rawDealId === "string" ? rawDealId : "";

	const result = await resolveRedirect({ db: getDb(), waitUntil }, dealId, {
		userAgent: headerValue(req, "user-agent"),
		referer: headerValue(req, "referer"),
	});

	if (result.kind === "redirect") {
		res.statusCode = 302;
		res.setHeader("location", result.location);
		res.end();
		return;
	}
	res.statusCode = 404;
	res.setHeader("content-type", "text/plain; charset=utf-8");
	res.end("Not found");
}
