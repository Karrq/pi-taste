import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLedgerRecord } from "../src/ledger/index.js";
import { appendLedger, foldLedger, readLedger, tasteEntryId } from "../src/ledger/index.js";
import type { LedgerRecord, TasteEntry } from "../src/ledger/index.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function upsert(value: TasteEntry): LedgerRecord {
	return { type: "entry.upserted", at: value.updatedAt, entry: value };
}

describe("ledger store", () => {
	it("round-trips records through an NDJSON file", () => {
		const path = join(tempDir(), "ledger.ndjson");
		const records: LedgerRecord[] = [upsert(entry("Always use tabs"))];
		appendLedger(path, records);
		expect(readLedger(path)).toEqual(records);
	});

	it("skips malformed lines instead of failing the read", () => {
		const path = join(tempDir(), "ledger.ndjson");
		appendLedger(path, [upsert(entry("Prefer named exports"))]);
		appendLedger(path, [{ type: "entry.upserted", at: "x", entry: { id: "bad" } } as unknown as LedgerRecord]);
		expect(readLedger(path)).toHaveLength(1);
	});
});

describe("foldLedger", () => {
	it("tombstones a retracted entry", () => {
		const value = entry("Never use default exports");
		const folded = foldLedger([
			upsert(value),
			{ type: "entry.retracted", at: "2026-01-02T00:00:00.000Z", entryId: value.id, reason: "superseded" },
		]);
		expect(folded.activeEntries).toHaveLength(0);
		expect(folded.retractedIds.has(value.id)).toBe(true);
	});

	it("revives a retracted id when it is upserted again", () => {
		const value = entry("Prefer Composition API");
		const folded = foldLedger([
			upsert(value),
			{ type: "entry.retracted", at: "2026-01-02T00:00:00.000Z", entryId: value.id, reason: "stale" },
			upsert({ ...value, confidence: 0.8, updatedAt: "2026-01-03T00:00:00.000Z" }),
		]);
		expect(folded.activeEntries).toHaveLength(1);
		expect(folded.activeEntries[0]?.confidence).toBe(0.8);
	});
});

describe("tasteEntryId", () => {
	it("is stable across case, whitespace and trailing punctuation", () => {
		expect(tasteEntryId("Use   TABS.")).toBe(tasteEntryId("use tabs"));
	});
});

describe("entry.merged validation", () => {
	it("accepts a merge that cites other entries", () => {
		const source = entry("Use tabs");
		const merged = entry("Always use tabs");
		expect(isLedgerRecord({ type: "entry.merged", at: "2026-01-02T00:00:00.000Z", entry: merged, fromIds: [source.id] })).toBe(true);
	});

	it("rejects a merge that lists its own entry id as a source", () => {
		const merged = entry("Always use tabs");
		expect(isLedgerRecord({ type: "entry.merged", at: "2026-01-02T00:00:00.000Z", entry: merged, fromIds: [merged.id] })).toBe(false);
	});
});
