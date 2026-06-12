/**
 * dolarapi.com client for the "dólar tarjeta" rate, used to show an
 * approximate ARS price next to the USD fare. Free, no auth. If it
 * fails we publish USD-only — never block a post on this.
 */

const DOLAR_TARJETA_URL = "https://dolarapi.com/v1/dolares/tarjeta";
const DEFAULT_TTL_MS = 3_600_000; // cache the rate for 1 hour
const DEFAULT_TIMEOUT_MS = 10_000;

export interface DolarClient {
	/** ARS per USD (venta), or null when the API is unavailable. */
	getTarjetaRate(): Promise<number | null>;
}

export interface DolarClientOptions {
	fetchImpl?: typeof fetch;
	ttlMs?: number;
	timeoutMs?: number;
	now?: () => number;
}

export function createDolarClient(
	options: DolarClientOptions = {},
): DolarClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = options.now ?? Date.now;

	let cachedRate: number | null = null;
	let cachedAt = 0;

	return {
		async getTarjetaRate() {
			if (cachedRate !== null && now() - cachedAt < ttlMs) {
				return cachedRate;
			}
			try {
				const response = await fetchImpl(DOLAR_TARJETA_URL, {
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!response.ok) return null;
				const body = (await response.json()) as { venta?: unknown };
				if (typeof body.venta !== "number" || body.venta <= 0) return null;
				cachedRate = body.venta;
				cachedAt = now();
				return cachedRate;
			} catch {
				// Failures are not cached: the next post tries again.
				return null;
			}
		},
	};
}
