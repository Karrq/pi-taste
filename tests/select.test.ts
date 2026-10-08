import { describe, expect, it } from "vitest";
import { tasteEntryId, type TasteEntry } from "../src/ledger/index.js";
import { findEntry } from "../src/select.js";

function entry(content: string): TasteEntry {
	const at = "2026-01-01T00:00:00.000Z";
	return {
		id: tasteEntryId(content),
		content,
		category: "general",
		confidence: 0.6,
		explicit: false,
		scope: "project",
		signalIds: ["s"],
		projectKeys: ["--k--"],
		createdAt: at,
		updatedAt: at,
	};
}

describe("findEntry", () => {
	it("matches a full id behind the id: prefix", () => {
		const value = entry("Always use tabs");
		expect(findEntry([value], `id:${value.id}`)?.id).toBe(value.id);
	});

	it("matches an id prefix behind id:", () => {
		const value = entry("Always use tabs");
		expect(findEntry([value], `id:${value.id.slice(0, 6)}`)?.id).toBe(value.id);
	});

	it("treats a bare id as content, not an id", () => {
		const value = entry("Always use tabs");
		expect(findEntry([value], value.id)).toBeUndefined();
	});

	it("matches content exactly and then by substring", () => {
		const value = entry("Always use tabs");
		expect(findEntry([value], "always use tabs.")?.id).toBe(value.id);
		expect(findEntry([value], "tabs")?.id).toBe(value.id);
	});
});
