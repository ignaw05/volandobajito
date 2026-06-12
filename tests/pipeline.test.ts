import { describe, expect, it } from "vitest";
import type { FunnelStats } from "../src/db/queries.js";
import { type PipelineDeps, runPipeline } from "../src/pipeline/run.js";

const NOW = Date.parse("2026-06-12T12:00:00Z");

interface Harness {
	deps: PipelineDeps;
	stages: string[];
	logs: string[];
	statsRequests: string[];
}

function harness(options: {
	silentMode: boolean;
	stats?: FunnelStats;
	scanError?: Error;
}): Harness {
	const stages: string[] = [];
	const logs: string[] = [];
	const statsRequests: string[] = [];
	const deps: PipelineDeps = {
		scan: async () => {
			if (options.scanError) throw options.scanError;
			stages.push("scan");
		},
		detect: async () => {
			stages.push("detect");
		},
		verify: async () => {
			stages.push("verify");
		},
		getFunnelStatsSince: async (sinceIso) => {
			statsRequests.push(sinceIso);
			return (
				options.stats ?? { candidates: 0, verified: 0, published: 0, clicks: 0 }
			);
		},
		silentMode: options.silentMode,
		now: () => NOW,
		log: (line) => logs.push(line),
	};
	return { deps, stages, logs, statsRequests };
}

describe("runPipeline", () => {
	it("runs scan -> detect -> verify in order when not silent", async () => {
		const h = harness({ silentMode: false });
		await runPipeline(h.deps);
		expect(h.stages).toEqual(["scan", "detect", "verify"]);
	});

	it("skips verify under SILENT_MODE and says so", async () => {
		const h = harness({ silentMode: true });
		await runPipeline(h.deps);
		expect(h.stages).toEqual(["scan", "detect"]);
		expect(h.logs.some((line) => line.includes("SILENT_MODE=true"))).toBe(true);
	});

	it("closes the run with the 24h funnel summary", async () => {
		const h = harness({
			silentMode: true,
			stats: { candidates: 7, verified: 3, published: 1, clicks: 12 },
		});
		await runPipeline(h.deps);
		expect(h.statsRequests).toEqual(["2026-06-11T12:00:00.000Z"]);
		const summary = h.logs.at(-1);
		expect(summary).toContain("7 candidates");
		expect(summary).toContain("3 verified");
		expect(summary).toContain("1 published");
		expect(summary).toContain("12 clicks");
	});

	it("aborts on a failed stage without running the next ones", async () => {
		const h = harness({
			silentMode: false,
			scanError: new Error("travelpayouts down"),
		});
		await expect(runPipeline(h.deps)).rejects.toThrow("travelpayouts down");
		expect(h.stages).toEqual([]);
		expect(h.statsRequests).toEqual([]);
	});
});
