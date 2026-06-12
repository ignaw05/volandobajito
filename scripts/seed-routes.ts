import { loadConfigSubset } from "../src/config.js";
import { createSupabase } from "../src/db/queries.js";
import { expandRoutes, seedRoutesSql } from "../src/db/routeSeed.js";

const UPSERT_CHUNK_SIZE = 500;

async function main(): Promise<void> {
	if (process.argv.includes("--sql")) {
		process.stdout.write(seedRoutesSql());
		return;
	}

	const config = loadConfigSubset("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
	const supabase = createSupabase(
		config.SUPABASE_URL,
		config.SUPABASE_SERVICE_ROLE_KEY,
	);

	const routes = expandRoutes();
	for (let i = 0; i < routes.length; i += UPSERT_CHUNK_SIZE) {
		const chunk = routes.slice(i, i + UPSERT_CHUNK_SIZE);
		const { error } = await supabase.from("routes").upsert(chunk, {
			onConflict: "origin,destination",
			ignoreDuplicates: true,
		});
		if (error) {
			throw new Error(
				`Failed to upsert routes (chunk at ${i}): ${error.message}`,
			);
		}
	}

	const { count, error } = await supabase
		.from("routes")
		.select("*", { count: "exact", head: true })
		.eq("active", true);
	if (error) {
		throw new Error(`Failed to count active routes: ${error.message}`);
	}

	console.log(
		`Seed complete: ${routes.length} route definitions upserted, ${count} active routes in DB.`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
