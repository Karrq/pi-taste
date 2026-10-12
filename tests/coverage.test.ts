import { describe, expect, it } from "vitest";
import {
	TASTE_COVERAGE,
	TASTE_COVERAGE_RESET,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	planCoverageUndo,
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

function coverage(coversUpToId: string, opId?: string): SessionEntry {
	return {
		type: "custom",
		id: `cov-${coversUpToId}`,
		customType: TASTE_COVERAGE,
		data: { coversUpToId, signalCount: 1, ...(opId ? { opId } : {}) },
	};
}

function coverageReset(coversUpToId?: string): SessionEntry {
	return {
		type: "custom",
		id: `cov-reset-${coversUpToId ?? "none"}`,
		customType: TASTE_COVERAGE_RESET,
		data: coversUpToId ? { coversUpToId } : {},
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

	it("a reset marker rewinds the watermark", () => {
		const entries = [message("m1", "a"), coverage("m1"), message("m2", "b"), coverage("m2"), coverageReset("m1")];
		expect(latestCoverageIndex(entries)).toBe(0);
		expect(latestCoverageMarkerId(entries)).toBe("m1");
	});

	it("a reset with no marker clears coverage entirely", () => {
		const entries = [message("m1", "a"), coverage("m1"), coverageReset()];
		expect(latestCoverageIndex(entries)).toBe(-1);
		expect(latestCoverageMarkerId(entries)).toBeUndefined();
	});

	it("coverage after a reset moves forward again", () => {
		const entries = [message("m1", "a"), coverage("m1"), message("m2", "b"), coverageReset(), coverage("m2")];
		expect(latestCoverageIndex(entries)).toBe(2);
		expect(latestCoverageMarkerId(entries)).toBe("m2");
	});
});

describe("planCoverageUndo", () => {
	it("rewinds to the watermark that remains after dropping the op's markers", () => {
		const entries = [
			message("m1", "a"),
			coverage("m1", "op1"),
			message("m2", "b"),
			coverage("m2", "op2"),
			message("m3", "c"),
		];
		expect(planCoverageUndo(entries, ["op2"])).toEqual({ removed: 1, coversUpToId: "m1" });
	});

	it("clears coverage when the undone op was the only extraction", () => {
		const entries = [message("m1", "a"), coverage("m1", "op1")];
		expect(planCoverageUndo(entries, ["op1"])).toEqual({ removed: 1 });
	});

	it("returns undefined when the op wrote no coverage", () => {
		const entries = [message("m1", "a"), coverage("m1", "op1")];
		expect(planCoverageUndo(entries, ["op-other"])).toBeUndefined();
		expect(planCoverageUndo(entries, [])).toBeUndefined();
	});
});

describe("sourceEntriesAfter", () => {
	it("returns only source entries after the index", () => {
		const entries = [message("m1", "a"), coverage("m1"), message("m2", "b"), message("m3", "c")];
		expect(sourceEntriesAfter(entries, 1).map((entry) => entry.id)).toEqual(["m2", "m3"]);
	});
});
