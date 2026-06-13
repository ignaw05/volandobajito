import { describe, expect, it } from "vitest";
import {
	createFallbackVerifier,
	fliDegradationAlert,
	isFallbackVerifier,
} from "../src/clients/fallbackVerifier.js";
import type {
	FlightVerifier,
	VerificationResult,
} from "../src/clients/flightVerifier.js";

const ALIVE: VerificationResult = { alive: true, priceUsd: 500 };
const FALLBACK_RESULT: VerificationResult = { alive: true, priceUsd: 777 };

/** A verifier whose every call returns `result` or throws `result` if Error. */
function stub(result: VerificationResult | Error): {
	verifier: FlightVerifier;
	calls: () => number;
} {
	let calls = 0;
	return {
		calls: () => calls,
		verifier: {
			async verify() {
				calls += 1;
				if (result instanceof Error) throw result;
				return result;
			},
		},
	};
}

describe("createFallbackVerifier", () => {
	it("returns the primary result without touching the fallback", async () => {
		const primary = stub(ALIVE);
		const fallback = stub(FALLBACK_RESULT);
		const v = createFallbackVerifier(primary.verifier, fallback.verifier, 5);

		const result = await v.verify("EZE", "MAD", "2026-07-01");
		expect(result).toBe(ALIVE);
		expect(fallback.calls()).toBe(0);
		expect(v.stats).toMatchObject({
			primaryCalls: 1,
			primaryFailures: 0,
			fallbackCalls: 0,
		});
	});

	it("falls back to the paid provider when the primary throws", async () => {
		const primary = stub(new Error("fli: blocked"));
		const fallback = stub(FALLBACK_RESULT);
		const v = createFallbackVerifier(primary.verifier, fallback.verifier, 5);

		const result = await v.verify("EZE", "MAD", "2026-07-01");
		expect(result).toBe(FALLBACK_RESULT);
		expect(v.stats).toMatchObject({
			primaryCalls: 1,
			primaryFailures: 1,
			fallbackCalls: 1,
		});
	});

	it("stops falling back once the paid budget is spent", async () => {
		const primary = stub(new Error("fli: blocked"));
		const fallback = stub(FALLBACK_RESULT);
		const v = createFallbackVerifier(primary.verifier, fallback.verifier, 1);

		await v.verify("EZE", "MAD", "2026-07-01");
		// Second failure has no budget left → the primary error propagates.
		await expect(v.verify("EZE", "MIA", "2026-07-01")).rejects.toThrow(
			/fli: blocked/,
		);
		expect(v.stats.fallbackCalls).toBe(1);
		expect(v.stats.primaryFailures).toBe(2);
	});

	it("propagates the primary error when no fallback is configured", async () => {
		const primary = stub(new Error("fli: blocked"));
		const v = createFallbackVerifier(primary.verifier, null, 5);
		await expect(v.verify("EZE", "MAD", "2026-07-01")).rejects.toThrow(
			/fli: blocked/,
		);
		expect(v.stats.fallbackCalls).toBe(0);
	});

	it("verifyPrimaryOnly never spends the paid fallback", async () => {
		const primary = stub(new Error("fli: blocked"));
		const fallback = stub(FALLBACK_RESULT);
		const v = createFallbackVerifier(primary.verifier, fallback.verifier, 5);
		await expect(
			v.verifyPrimaryOnly("EZE", "MAD", "2026-07-01"),
		).rejects.toThrow(/fli: blocked/);
		expect(fallback.calls()).toBe(0);
		expect(v.stats).toMatchObject({ primaryFailures: 1, fallbackCalls: 0 });
	});
});

describe("isFallbackVerifier", () => {
	it("distinguishes a wrapped verifier from a plain one", () => {
		const plain = stub(ALIVE).verifier;
		const wrapped = createFallbackVerifier(plain, null, 0);
		expect(isFallbackVerifier(wrapped)).toBe(true);
		expect(isFallbackVerifier(plain)).toBe(false);
	});
});

describe("fliDegradationAlert", () => {
	const base = { fallbackCalls: 0, fallbackBudget: 5 };

	it("returns null when fli had no failures", () => {
		expect(
			fliDegradationAlert({ ...base, primaryCalls: 10, primaryFailures: 0 }),
		).toBeNull();
	});

	it("reports a soft degradation on isolated failures", () => {
		const text = fliDegradationAlert({
			primaryCalls: 10,
			primaryFailures: 2,
			fallbackCalls: 2,
			fallbackBudget: 5,
		});
		expect(text).toMatch(/degradado/);
		expect(text).toMatch(/2\/10/);
	});

	it("reports a collapse when every fli call failed", () => {
		const text = fliDegradationAlert({
			primaryCalls: 4,
			primaryFailures: 4,
			fallbackCalls: 4,
			fallbackBudget: 5,
		});
		expect(text).toMatch(/CAÍDO/);
	});
});
