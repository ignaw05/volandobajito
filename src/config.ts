import "dotenv/config";
import { z } from "zod";

const booleanFlag = z
	.enum(["true", "false"])
	.transform((value) => value === "true");

const baseEnvSchema = z.object({
	// Supabase
	SUPABASE_URL: z.url({ error: "must be a valid URL" }),
	SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

	// Layer 1: cached price sweep
	TRAVELPAYOUTS_TOKEN: z.string().min(1),

	// Layer 3: real-time verification
	VERIFIER_PROVIDER: z.enum(["searchapi", "flightapi"]).default("searchapi"),
	SEARCHAPI_KEY: z.string().optional(),
	FLIGHTAPI_KEY: z.string().optional(),
	MAX_VERIFICATIONS_PER_RUN: z.coerce.number().int().positive().default(15),

	// Optional baseline bootstrap
	SERPAPI_KEY: z.string().optional(),

	// Telegram
	TELEGRAM_BOT_TOKEN: z.string().min(1),
	CURATOR_CHAT_ID: z.string().min(1),
	CHANNEL_ID: z.string().min(1),

	// Click tracking
	REDIRECT_BASE_URL: z.url({ error: "must be a valid URL" }),

	// Operation
	SILENT_MODE: booleanFlag.default(true),
	// Reserved flag — intentionally has no implementation behind it.
	AUTO_PUBLISH: booleanFlag.default(false),
});

const envSchema = baseEnvSchema.check((ctx) => {
	const env = ctx.value;
	if (env.VERIFIER_PROVIDER === "searchapi" && !env.SEARCHAPI_KEY) {
		ctx.issues.push({
			code: "custom",
			path: ["SEARCHAPI_KEY"],
			message: "required when VERIFIER_PROVIDER=searchapi",
			input: env.SEARCHAPI_KEY,
		});
	}
	if (env.VERIFIER_PROVIDER === "flightapi" && !env.FLIGHTAPI_KEY) {
		ctx.issues.push({
			code: "custom",
			path: ["FLIGHTAPI_KEY"],
			message: "required when VERIFIER_PROVIDER=flightapi",
			input: env.FLIGHTAPI_KEY,
		});
	}
});

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
	override name = "ConfigError";
}

function toConfigError(issues: z.core.$ZodIssue[]): ConfigError {
	const lines = issues.map((issue) => {
		const name = issue.path.join(".") || "(root)";
		const detail =
			issue.code === "invalid_type" && issue.input === undefined
				? "missing required environment variable"
				: issue.message;
		return `  - ${name}: ${detail}`;
	});
	return new ConfigError(
		`Invalid environment configuration:\n${lines.join("\n")}`,
	);
}

/**
 * Pure validation of an env-shaped record. Throws ConfigError with a message
 * that names every missing or invalid variable.
 */
export function parseEnv(env: Record<string, string | undefined>): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		throw toConfigError(result.error.issues);
	}
	return result.data;
}

/**
 * Validates only the given variables. For standalone scripts (e.g. seeding)
 * that should not demand the full production environment.
 */
export function parseEnvSubset<K extends keyof Config>(
	keys: readonly K[],
	env: Record<string, string | undefined>,
): Pick<Config, K> {
	const mask = Object.fromEntries(keys.map((key) => [key, true]));
	const subsetSchema = baseEnvSchema.pick(
		mask as { [P in keyof Config]?: true },
	);
	const result = subsetSchema.safeParse(env);
	if (!result.success) {
		throw toConfigError(result.error.issues);
	}
	return result.data as Pick<Config, K>;
}

/**
 * Validates process.env at startup. Every entrypoint must call this first;
 * on failure it prints which variables are wrong and kills the process.
 */
export function loadConfig(): Config {
	return failFast(() => parseEnv(process.env));
}

/** Subset variant of loadConfig, same fail-fast behaviour. */
export function loadConfigSubset<K extends keyof Config>(
	...keys: K[]
): Pick<Config, K> {
	return failFast(() => parseEnvSubset(keys, process.env));
}

function failFast<T>(parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		if (error instanceof ConfigError) {
			console.error(error.message);
			process.exit(1);
		}
		throw error;
	}
}
