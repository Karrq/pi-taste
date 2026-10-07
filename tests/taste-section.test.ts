import { describe, expect, it } from "vitest";
import { tasteEntryId, type TasteEntry } from "../src/ledger/index.js";
import { mergeTasteEntries, renderTasteSection } from "../src/render/taste-section.js";

function entry(content: string, overrides: Partial<TasteEntry> = {}): TasteEntry {
	const at = "2026-01-01T00:00:00.000Z";
	return {
		id: tasteEntryId(content),
		content,
		category: "general",
		confidence: 0.6,
		explicit: false,
		scope: "project",
		signalIds: [],
		projectKeys: ["--p--"],
		createdAt: at,
		updatedAt: at,
		...overrides,
	};
}

describe("mergeTasteEntries", () => {
	it("lets a project entry override a global entry with the same content", () => {
		const merged = mergeTasteEntries(
			[entry("Prefer named exports", { confidence: 0.9, scope: "project" })],
			[entry("prefer named exports.", { confidence: 0.4, scope: "global" })],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.confidence).toBe(0.9);
	});
});

describe("renderTasteSection", () => {
	it("returns undefined when nothing clears the confidence floor", () => {
		expect(renderTasteSection([entry("x", { confidence: 0.2 })], { confidenceFloor: 0.5, maxTokens: 500 }))
			.toBeUndefined();
	});

	it("renders a fenced section ordered by confidence", () => {
		const section = renderTasteSection(
			[entry("omega-pref", { confidence: 0.6 }), entry("alpha-pref", { confidence: 0.95 })],
			{ confidenceFloor: 0.5, maxTokens: 500 },
		);
		expect(section).toContain("<taste>");
		expect(section).toContain("</taste>");
		expect(section?.indexOf("alpha-pref")).toBeLessThan(section?.indexOf("omega-pref") ?? -1);
	});

	it("stops before the token budget", () => {
		const long = entry("x".repeat(400), { confidence: 0.9 });
		const section = renderTasteSection([long], { confidenceFloor: 0.1, maxTokens: 50 });
		expect(section).toBeUndefined();
	});
});
