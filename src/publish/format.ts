import { cityName } from "./cities.js";

/**
 * Pure text builders for every user-facing message. No I/O here:
 * everything is snapshot-testable. Copy is rioplatense Spanish by
 * design (see plan §2).
 */

const MONTHS_ES = [
	"enero",
	"febrero",
	"marzo",
	"abril",
	"mayo",
	"junio",
	"julio",
	"agosto",
	"septiembre",
	"octubre",
	"noviembre",
	"diciembre",
];

function dayAndMonth(isoDate: string): { day: number; month: string } {
	const day = Number(isoDate.slice(8, 10));
	const month = MONTHS_ES[Number(isoDate.slice(5, 7)) - 1] ?? "";
	return { day, month };
}

/** "12-28 de marzo" | "28 de marzo - 5 de abril" | "12 de marzo (solo ida)" */
export function formatDateRange(
	departDate: string,
	returnDate: string | null,
): string {
	const depart = dayAndMonth(departDate);
	if (!returnDate) {
		return `${depart.day} de ${depart.month} (solo ida)`;
	}
	const back = dayAndMonth(returnDate);
	if (depart.month === back.month) {
		return `${depart.day}-${back.day} de ${depart.month}`;
	}
	return `${depart.day} de ${depart.month} - ${back.day} de ${back.month}`;
}

function formatArs(amount: number): string {
	return `$${new Intl.NumberFormat("es-AR").format(Math.round(amount))}`;
}

export interface PostData {
	dealId: string;
	origin: string;
	destination: string;
	priceUsd: number;
	/** ARS per USD (dólar tarjeta) or null to publish USD-only. */
	arsRate: number | null;
	discountPct: number | null;
	airline: string | null;
	direct: boolean | null;
	departDate: string;
	returnDate: string | null;
	isErrorFare: boolean;
	redirectBaseUrl: string;
}

/** The public channel post. */
export function formatDealPost(d: PostData): string {
	const route = `${cityName(d.origin)} → ${cityName(d.destination)}`;
	const header = d.isErrorFare
		? `🔥 ¡TARIFA ERROR! ${route}`
		: `✈️ ¡GANGA! ${route}`;

	const ars =
		d.arsRate !== null
			? ` (≈ ${formatArs(d.priceUsd * d.arsRate)} dólar tarjeta)`
			: "";
	const lines = [header, "", `💵 USD ${d.priceUsd}${ars}`];

	if (d.discountPct !== null) {
		lines.push(
			`📉 ${Math.round(d.discountPct * 100)}% más barato que lo habitual en esta ruta`,
		);
	}
	const flightParts = [
		...(d.airline ? [d.airline] : []),
		...(d.direct === null ? [] : [d.direct ? "Directo" : "Con escalas"]),
	];
	if (flightParts.length > 0) {
		lines.push(`🛫 ${flightParts.join(" · ")}`);
	}
	lines.push(`📅 Fechas: ${formatDateRange(d.departDate, d.returnDate)}`);
	lines.push("", `👉 Ver vuelo: ${d.redirectBaseUrl}/go/${d.dealId}`);
	lines.push(
		"",
		"⚡ Las tarifas así suelen durar horas. Verificá el precio final antes de pagar.",
	);
	return lines.join("\n");
}

/** Prefix used when a published deal dies (recheck edits the post). */
export function formatExpiredPost(originalPost: string): string {
	return `⚠️ EXPIRADO — esta tarifa ya no está disponible.\n\n${originalPost}`;
}

export interface CuratorAlertData {
	origin: string;
	destination: string;
	cachedPriceUsd: number;
	verifiedPriceUsd: number;
	medianAtDetection: number | null;
	discountPct: number | null;
	airline: string | null;
	direct: boolean | null;
	departDate: string;
	returnDate: string | null;
	score: number | null;
	isErrorFare: boolean;
}

/** The private message the curator gets when a deal is verified. */
export function formatCuratorAlert(d: CuratorAlertData): string {
	const lines = [
		`🔔 Deal verificado: ${d.origin} → ${d.destination}` +
			(d.isErrorFare ? " · 🔥 TARIFA ERROR" : ""),
		`💵 caché USD ${d.cachedPriceUsd} → en vivo USD ${d.verifiedPriceUsd}`,
	];
	if (d.discountPct !== null && d.medianAtDetection !== null) {
		lines.push(
			`📉 ${Math.round(d.discountPct * 100)}% bajo la mediana (USD ${d.medianAtDetection})`,
		);
	}
	const flightParts = [
		...(d.airline ? [d.airline] : []),
		...(d.direct === null ? [] : [d.direct ? "Directo" : "Con escalas"]),
	];
	if (flightParts.length > 0) {
		lines.push(`🛫 ${flightParts.join(" · ")}`);
	}
	lines.push(
		`📅 ${d.departDate}${d.returnDate ? ` → ${d.returnDate}` : " (solo ida)"}`,
	);
	if (d.score !== null) {
		lines.push(`⭐ Score ${Math.round(d.score)}`);
	}
	return lines.join("\n");
}
