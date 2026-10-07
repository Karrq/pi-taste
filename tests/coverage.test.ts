import { describe, expect, it } from "vitest";
import {
	TASTE_COVERAGE,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	sourceEntriesAfter,
} from "../src/session/coverage.js";
import type { SessionEntry } from "../src/session/types.js";

function message(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	};
}

function coverage(coversUpToId: string): SessionEntry {
	return {
		type: "custom",
		id: `cov-${coversUpToId}`,
		customType: TASTE_COVERAGE,
		data: { coversUpToId, signalCount: 1 },
	};
}

describe("isSourceEntry", () => {
	it("accepts messages and custom messages, rejects memory entries", () => {
		expect(isSourceEntry({ type: "message", id: "a" })).toBe(true);
		expect(isSourceEntry({ type: "custom_message", id: "b" })).toBe(true);
		expect(isSourceEntry({ type: "branch_summary", id: "c" })).toBe(true);
		expect(isSourceEntry(coverage("x"))).toBe(false);
	});
});

describe("coverage watermark", () => {
	it("finds the furthest covered source index and marker", () => {
		const entries = [message("m1", "a"), message("m2", "b"), coverage("m2"), message("m3", "c")];
		expect(latestCoverageIndex(entries)).toBe(1);
		expect(latestCoverageMarkerId(entries)).toBe("m2");
	});

	it("returns -1 when nothing is covered", () => {
		expect(latestCoverageIndex([message("m1", "a")])).toBe(-1);
	});
});

describe("sourceEntriesAfter", () => {
	it("returns only source entries after the index", () => {
		const entries = [message("m1", "a"), coverage("m1"), message("m2", "b"), message("m3", "c")];
		expect(sourceEntriesAfter(entries, 1).map((entry) => entry.id)).toEqual(["m2", "m3"]);
	});
});
