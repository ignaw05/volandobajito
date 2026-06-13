import type { FlightVerifier, VerificationResult } from "./flightVerifier.js";

/**
 * Composes a free primary verifier (fli) with a paid fallback (SearchApi).
 *
 * Per call: try the primary; if it THROWS — a fare gone (`alive:false`) is a
 * valid answer, not a failure — fall back to the paid provider, but only while
 * paid calls remain under `fallbackBudget`. With no budget left (or no fallback
 * configured) the primary error propagates, so the pipeline leaves the deal as
 * a candidate and can retry it later.
 *
 * `stats` lets the pipeline report real paid usage and decide whether fli has
 * degraded (some failures) or collapsed (every call failed — likely a block).
 */

export interface FallbackStats {
	/** Primary (fli) attempts made. */
	primaryCalls: number;
	/** Primary attempts that threw. */
	primaryFailures: number;
	/** Paid fallback (SearchApi) calls actually made. */
	fallbackCalls: number;
	/** Hard cap on paid fallback calls. */
	fallbackBudget: number;
}

export interface FallbackVerifier extends FlightVerifier {
	readonly stats: FallbackStats;
	/**
	 * Primary-only attempt with no paid fallback — for end-of-run retries of
	 * candidates that errored, "before giving up", without spending budget.
	 */
	verifyPrimaryOnly(
		origin: string,
		dest: string,
		departDate: string,
		returnDate?: string,
	): Promise<VerificationResult>;
}

export function isFallbackVerifier(
	verifier: FlightVerifier,
): verifier is FallbackVerifier {
	return "stats" in verifier && "verifyPrimaryOnly" in verifier;
}

/**
 * One-line operator alert when the fli primary failed this run: a loud
 * "collapsed" message if EVERY attempt failed (likely a Google block on the
 * runner IP), a softer "degraded" one for isolated failures. Null when fli was
 * healthy (no failures) — nothing to report.
 */
export function fliDegradationAlert(stats: FallbackStats): string | null {
	if (stats.primaryFailures === 0 || stats.primaryCalls === 0) return null;
	const paid = `fallbacks pagos a SearchApi: ${stats.fallbackCalls}/${stats.fallbackBudget}`;
	if (stats.primaryFailures >= stats.primaryCalls) {
		return (
			`🚨 fli CAÍDO: falló en las ${stats.primaryCalls} llamadas de esta ` +
			`corrida (posible bloqueo de Google desde el runner). ${paid}.`
		);
	}
	return (
		`⚠️ fli degradado: ${stats.primaryFailures}/${stats.primaryCalls} ` +
		`llamadas fallaron; ${paid}.`
	);
}

export function createFallbackVerifier(
	primary: FlightVerifier,
	fallback: FlightVerifier | null,
	fallbackBudget: number,
	log: (line: string) => void = console.log,
): FallbackVerifier {
	const stats: FallbackStats = {
		primaryCalls: 0,
		primaryFailures: 0,
		fallbackCalls: 0,
		fallbackBudget,
	};

	return {
		stats,
		async verifyPrimaryOnly(origin, dest, departDate, returnDate) {
			stats.primaryCalls += 1;
			try {
				return await primary.verify(origin, dest, departDate, returnDate);
			} catch (error) {
				stats.primaryFailures += 1;
				throw error;
			}
		},
		async verify(origin, dest, departDate, returnDate) {
			const label = `${origin}-${dest} ${departDate}`;
			stats.primaryCalls += 1;
			try {
				return await primary.verify(origin, dest, departDate, returnDate);
			} catch (primaryError) {
				stats.primaryFailures += 1;
				const reason =
					primaryError instanceof Error
						? primaryError.message
						: String(primaryError);
				if (!fallback || stats.fallbackCalls >= fallbackBudget) {
					const why = fallback
						? `paid budget exhausted (${fallbackBudget})`
						: "no paid fallback configured";
					log(`verify: fli failed for ${label} (${reason}); ${why}`);
					throw primaryError;
				}
				stats.fallbackCalls += 1;
				log(
					`verify: fli failed for ${label} (${reason}); falling back to ` +
						`SearchApi (paid ${stats.fallbackCalls}/${fallbackBudget})`,
				);
				return await fallback.verify(origin, dest, departDate, returnDate);
			}
		},
	};
}
