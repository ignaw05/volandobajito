import { describe, expect, it } from "vitest";
import {
	type CuratorAlertData,
	formatAutoPublishAlert,
	formatCuratorAlert,
	formatDateRange,
	formatDealPost,
	formatExpiredPost,
	type PostData,
} from "../src/publish/format.js";

const basePost: PostData = {
	dealId: "deal-uuid-1",
	origin: "EZE",
	destination: "MAD",
	priceUsd: 489,
	arsRate: 1500,
	discountPct: 0.38,
	airline: "Iberia",
	direct: true,
	departDate: "2027-03-12",
	returnDate: "2027-03-28",
	isErrorFare: false,
	redirectBaseUrl: "https://go.example.com",
};

describe("formatDateRange", () => {
	it("collapses same-month round trips", () => {
		expect(formatDateRange("2027-03-12", "2027-03-28")).toBe("12-28 de marzo");
	});

	it("spells both months when they differ", () => {
		expect(formatDateRange("2027-03-28", "2027-04-05")).toBe(
			"28 de marzo - 5 de abril",
		);
	});

	it("marks one-way trips", () => {
		expect(formatDateRange("2027-03-12", null)).toBe("12 de marzo (solo ida)");
	});
});

describe("formatDealPost", () => {
	it("full post with ARS rate and round trip", () => {
		expect(formatDealPost(basePost)).toMatchSnapshot();
	});

	it("publishes USD-only when the ARS rate is unavailable", () => {
		const post = formatDealPost({ ...basePost, arsRate: null });
		expect(post).not.toContain("dólar tarjeta");
		expect(post).toMatchSnapshot();
	});

	it("one-way post without return date", () => {
		expect(formatDealPost({ ...basePost, returnDate: null })).toMatchSnapshot();
	});

	it("error fare gets its own header copy", () => {
		const post = formatDealPost({ ...basePost, isErrorFare: true });
		expect(post).toContain("🔥 ¡TARIFA ERROR!");
		expect(post).not.toContain("¡GANGA!");
		expect(post).toMatchSnapshot();
	});

	it("omits flight line and discount when data is missing", () => {
		expect(
			formatDealPost({
				...basePost,
				airline: null,
				direct: null,
				discountPct: null,
			}),
		).toMatchSnapshot();
	});

	it("falls back to the raw IATA code for unmapped airports", () => {
		const post = formatDealPost({ ...basePost, destination: "XXX" });
		expect(post).toContain("Buenos Aires → XXX");
	});
});

describe("formatExpiredPost", () => {
	it("prepends the expired banner to the original post", () => {
		const expired = formatExpiredPost(formatDealPost(basePost));
		expect(expired.startsWith("⚠️ EXPIRADO —")).toBe(true);
		expect(expired).toMatchSnapshot();
	});
});

describe("formatAutoPublishAlert", () => {
	it("wraps the exact post with the countdown warning", () => {
		const alert = formatAutoPublishAlert(formatDealPost(basePost), 5);
		expect(alert).toContain("se publica en ~5 min");
		expect(alert).toMatchSnapshot();
	});
});

describe("formatCuratorAlert", () => {
	const baseAlert: CuratorAlertData = {
		origin: "AEP",
		destination: "MAD",
		cachedPriceUsd: 913,
		verifiedPriceUsd: 941,
		medianAtDetection: 1404,
		discountPct: 0.35,
		airline: "LATAM",
		direct: false,
		departDate: "2026-08-19",
		returnDate: "2026-09-08",
		score: 52,
		isErrorFare: false,
	};

	it("full alert", () => {
		expect(formatCuratorAlert(baseAlert)).toMatchSnapshot();
	});

	it("flags error fares in the header", () => {
		const alert = formatCuratorAlert({ ...baseAlert, isErrorFare: true });
		expect(alert).toContain("🔥 TARIFA ERROR");
		expect(alert).toMatchSnapshot();
	});

	it("omits optional lines when stats are missing", () => {
		expect(
			formatCuratorAlert({
				...baseAlert,
				medianAtDetection: null,
				discountPct: null,
				airline: null,
				direct: null,
				score: null,
				returnDate: null,
			}),
		).toMatchSnapshot();
	});
});
