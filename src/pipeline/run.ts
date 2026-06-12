import { pathToFileURL } from "node:url";
import { createClient as createSupabase } from "@supabase/supabase-js";
import { loadConfigSubset } from "../config.js";
import { createDb, type FunnelStats } from "../db/queries.js";
import { main as detectMain } from "./detect.js";
import { main as scanMain } from "./scan.js";
import { main as verifyMain } from "./verify.js";

export interface PipelineDeps {
	scan: () => Promise<void>;
	detect: () => Promise<void>;
	verify: () => Promise<void>;
	getFunnelStatsSince: (sinceIso: string) => Promise<FunnelStats>;
	silentMode: boolean;
	now?: () => number;
	log?: (line: string) => void;
}

/**
 * Full pipeline run: scan -> detect -> verify, with verify skipped under
 * SILENT_MODE (test mode: the cron never spends paid calls). A stage that
 * fails aborts the run; later stages would only act on stale data.
 */
export async function runPipeline(deps: PipelineDeps): Promise<void> {
	const log = deps.log ?? console.log;
	const now = deps.now ?? Date.now;

	log("pipeline: scan");
	await deps.scan();
	log("pipeline: detect");
	await deps.detect();
	if (deps.silentMode) {
		log("pipeline: SILENT_MODE=true — verify skipped, zero paid calls");
	} else {
		log("pipeline: verify");
		await deps.verify();
	}

	const sinceIso = new Date(now() - 24 * 60 * 60 * 1000).toISOString();
	const stats = await deps.getFunnelStatsSince(sinceIso);
	log(
		`pipeline: funnel last 24h — ${stats.candidates} candidates, ` +
			`${stats.verified} verified, ${stats.published} published, ` +
			`${stats.clicks} clicks`,
	);
}

async function main(): Promise<void> {
	const config = loadConfigSubset(
		"SUPABASE_URL",
		"SUPABASE_SERVICE_ROLE_KEY",
		"SILENT_MODE",
	);
	const db = createDb(
		createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
	);
	await runPipeline({
		scan: scanMain,
		detect: detectMain,
		verify: verifyMain,
		getFunnelStatsSince: (sinceIso) => db.getFunnelStatsSince(sinceIso),
		silentMode: config.SILENT_MODE,
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
