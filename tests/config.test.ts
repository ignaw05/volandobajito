import { describe, expect, it } from "vitest";
import { ConfigError, parseEnv, parseEnvSubset } from "../src/config.js";

const validEnv: Record<string, string> = {
	SUPABASE_URL: "https://example.supabase.co",
	SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
	TRAVELPAYOUTS_TOKEN: "tp-token",
	SEARCHAPI_KEY: "searchapi-key",
	TELEGRAM_BOT_TOKEN: "123456:bot-token",
	CURATOR_CHAT_ID: "123456789",
	CHANNEL_ID: "@flightdeals",
	REDIRECT_BASE_URL: "https://go.example.com",
};

describe("parseEnv", () => {
	it("parses a valid environment and applies defaults", () => {
		const config = parseEnv(validEnv);
		expect(config.SUPABASE_URL).toBe("https://example.supabase.co");
		expect(config.VERIFIER_PROVIDER).toBe("searchapi");
		expect(config.MAX_VERIFICATIONS_PER_RUN).toBe(15);
		expect(config.SILENT_MODE).toBe(true);
		expect(config.AUTO_PUBLISH).toBe(false);
	});

	it("coerces boolean flags and numeric values", () => {
		const config = parseEnv({
			...validEnv,
			SILENT_MODE: "false",
			MAX_VERIFICATIONS_PER_RUN: "5",
		});
		expect(config.SILENT_MODE).toBe(false);
		expect(config.MAX_VERIFICATIONS_PER_RUN).toBe(5);
	});

	it("names the missing variable in the error message", () => {
		const { SUPABASE_URL: _omitted, ...incomplete } = validEnv;
		expect(() => parseEnv(incomplete)).toThrowError(ConfigError);
		expect(() => parseEnv(incomplete)).toThrowError(/SUPABASE_URL/);
	});

	it("names every missing variable when several are absent", () => {
		try {
			parseEnv({});
			expect.unreachable("parseEnv should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			const message = (error as ConfigError).message;
			expect(message).toContain("SUPABASE_URL");
			expect(message).toContain("TRAVELPAYOUTS_TOKEN");
			expect(message).toContain("TELEGRAM_BOT_TOKEN");
		}
	});

	it("requires the API key matching the chosen verifier provider", () => {
		const { SEARCHAPI_KEY: _omitted, ...withoutKey } = validEnv;
		expect(() => parseEnv(withoutKey)).toThrowError(/SEARCHAPI_KEY/);

		const flightapiEnv = { ...withoutKey, VERIFIER_PROVIDER: "flightapi" };
		expect(() => parseEnv(flightapiEnv)).toThrowError(/FLIGHTAPI_KEY/);
		expect(() =>
			parseEnv({ ...flightapiEnv, FLIGHTAPI_KEY: "fa-key" }),
		).not.toThrow();
	});

	it("rejects invalid values with a readable message", () => {
		expect(() =>
			parseEnv({ ...validEnv, REDIRECT_BASE_URL: "not-a-url" }),
		).toThrowError(/REDIRECT_BASE_URL/);
		expect(() => parseEnv({ ...validEnv, SILENT_MODE: "yes" })).toThrowError(
			/SILENT_MODE/,
		);
	});
});

describe("parseEnvSubset", () => {
	it("validates only the requested variables", () => {
		const config = parseEnvSubset(
			["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
			{
				SUPABASE_URL: "https://example.supabase.co",
				SUPABASE_SERVICE_ROLE_KEY: "key",
			},
		);
		expect(config.SUPABASE_URL).toBe("https://example.supabase.co");
	});

	it("still names missing variables within the subset", () => {
		expect(() =>
			parseEnvSubset(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], {}),
		).toThrowError(/SUPABASE_SERVICE_ROLE_KEY/);
	});
});
