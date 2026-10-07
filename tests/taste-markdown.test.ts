import { describe, expect, it } from "vitest";
import { tasteEntryId, type TasteEntry } from "../src/ledger/index.js";
import { renderTasteMarkdown } from "../src/render/taste-markdown.js";

function entry(content: string, overrides: Partial<TasteEntry> = {}): TasteEntry {
	const at = "2026-01-01T00:00:00.000Z";
	return {
		id: tasteEntryId(content),
		content,
		category: "general",
		confidence: 0.6,
		explicit: false,
		scope: "project",
		signalIds: ["s"],
		projectKeys: ["--p--"],
		createdAt: at,
		updatedAt: at,
		...overrides,
	};
}

describe("renderTasteMarkdown", () => {
	it("groups entries by category and shows confidence", () => {
		const markdown = renderTasteMarkdown(
			[
				entry("Always use tabs", { category: "formatting", confidence: 0.9 }),
				entry("Prefer named exports", { category: "typescript", confidence: 0.7, explicit: true }),
			],
			{ title: "Taste" },
		);
		expect(markdown).toContain("## formatting");
		expect(markdown).toContain("## typescript");
		expect(markdown).toContain("- Always use tabs (90%)");
		expect(markdown).toContain("- Prefer named exports (70%, explicit)");
	});

	it("renders an empty profile without a category heading", () => {
		const markdown = renderTasteMarkdown([], { title: "Taste" });
		expect(markdown).toContain("_No preferences recorded yet._");
		expect(markdown).not.toContain("## ");
	});
});
