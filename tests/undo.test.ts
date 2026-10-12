import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { rememberPreference } = await import("../src/remember.js");
const { newOpId } = await import("../src/ids.js");
const { undoLastOps } = await import("../src/undo.js");
const { foldLedger, tasteEntryId } = await import("../src/ledger/index.js");
const { appendLedger, readLedger } = await import("../src/ledger/store.js");
const { globalTasteDir, ledgerPath, projectTasteDir } = await import("../src/ledger/paths.js");

const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-undo-"));
	dirs.push(dir);
	agentDir.path = dir;
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("undoLastOps", () => {
	it("removes the records a command wrote and restores the ledger to empty", () => {
		const cwd = "/tmp/pi-taste-undo-a";
		rememberPreference({ cwd, text: "Always use tabs", promoteAtProjectCount: 5, opId: newOpId() });

		const before = readLedger(ledgerPath(projectTasteDir(cwd)));
		expect(before.length).toBeGreaterThan(0);
		expect(before.every((record) => typeof record.opId === "string")).toBe(true);

		const result = undoLastOps(cwd);
		expect(result.changed).toBe(true);
		expect(result.opIds).toHaveLength(1);
		expect(result.recordsRemoved).toBe(before.length);
		expect(readLedger(ledgerPath(projectTasteDir(cwd)))).toHaveLength(0);
		expect(foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries).toHaveLength(0);
	});

	it("undoes only the most recent operation by default and respects a count", () => {
		const cwd = "/tmp/pi-taste-undo-b";
		rememberPreference({ cwd, text: "First preference", promoteAtProjectCount: 5, opId: newOpId() });
		rememberPreference({ cwd, text: "Second preference", promoteAtProjectCount: 5, opId: newOpId() });

		const one = undoLastOps(cwd);
		expect(one.opIds).toHaveLength(1);
		const remaining = foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries;
		expect(remaining.map((entry) => entry.content)).toEqual(["First preference"]);

		const two = undoLastOps(cwd, 5);
		expect(two.opIds).toHaveLength(1);
		expect(foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries).toHaveLength(0);
	});

	it("removes a promoted operation from both the project and global ledgers", () => {
		const first = "/tmp/pi-taste-undo-c1";
		const second = "/tmp/pi-taste-undo-c2";
		rememberPreference({ cwd: first, text: "Prefer named exports", promoteAtProjectCount: 2, opId: newOpId() });
		rememberPreference({ cwd: second, text: "Prefer named exports", promoteAtProjectCount: 2, opId: newOpId() });
		expect(foldLedger(readLedger(ledgerPath(globalTasteDir()))).activeEntries).toHaveLength(1);

		const result = undoLastOps(second);
		expect(result.changed).toBe(true);
		expect(foldLedger(readLedger(ledgerPath(globalTasteDir()))).activeEntries).toHaveLength(0);
		expect(foldLedger(readLedger(ledgerPath(projectTasteDir(first)))).activeEntries).toHaveLength(1);
	});

	it("leaves records without an opId and unparseable lines untouched", () => {
		const cwd = "/tmp/pi-taste-undo-d";
		rememberPreference({ cwd, text: "Keep me", promoteAtProjectCount: 5, opId: newOpId() });
		const path = ledgerPath(projectTasteDir(cwd));
		const manual = {
			type: "signal.recorded",
			at: new Date().toISOString(),
			signal: {
				id: "manual000001",
				content: "manual signal",
				timestamp: "2026-01-01 00:00",
				kind: "stated",
				projectKey: "manual",
				sourceEntryIds: ["e1"],
			},
		};
		appendFileSync(path, `${JSON.stringify(manual)}\nnot json at all\n`, "utf-8");

		const result = undoLastOps(cwd);
		expect(result.recordsRemoved).toBe(2);
		const text = readFileSync(path, "utf-8");
		expect(text).toContain("manual signal");
		expect(text).toContain("not json at all");
		expect(foldLedger(readLedger(path)).activeEntries).toHaveLength(0);
	});

	it("reports nothing to undo when no ledger has operations", () => {
		const result = undoLastOps("/tmp/pi-taste-undo-empty");
		expect(result.changed).toBe(false);
		expect(result.opIds).toHaveLength(0);
	});

	it("a dry run previews the records and leaves the ledgers unchanged", () => {
		const cwd = "/tmp/pi-taste-undo-dry";
		rememberPreference({ cwd, text: "Keep me", promoteAtProjectCount: 5, opId: newOpId() });
		const path = ledgerPath(projectTasteDir(cwd));
		const before = readFileSync(path, "utf-8");

		const preview = undoLastOps(cwd, 1, { dryRun: true });
		expect(preview.changed).toBe(true);
		expect(preview.recordsRemoved).toBe(2);
		expect(preview.records).toHaveLength(2);
		expect(preview.records.every((record) => record.file === "project")).toBe(true);
		expect(preview.records.some((record) => record.summary.includes("Keep me"))).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe(before);

		const real = undoLastOps(cwd);
		expect(real.recordsRemoved).toBe(2);
		expect(readLedger(path)).toHaveLength(0);
	});

	it("lists a merge's restored sources in the dry preview", () => {
		const cwd = "/tmp/pi-taste-undo-merge";
		const path = ledgerPath(projectTasteDir(cwd));
		const at = "2026-01-01T00:00:00.000Z";
		const base = {
			category: "general",
			confidence: 0.6,
			explicit: false,
			scope: "project" as const,
			projectKeys: ["--k--"],
			createdAt: at,
			updatedAt: at,
		};
		const a = { ...base, id: tasteEntryId("Alpha preference"), content: "Alpha preference", signalIds: ["s1"] };
		const b = { ...base, id: tasteEntryId("Beta preference"), content: "Beta preference", signalIds: ["s2"] };
		const merged = {
			...base,
			id: tasteEntryId("Alpha and beta"),
			content: "Alpha and beta",
			signalIds: ["s1", "s2"],
			updatedAt: "2026-01-02T00:00:00.000Z",
		};
		appendLedger(path, [
			{ type: "entry.upserted", at, entry: a, opId: "op-old" },
			{ type: "entry.upserted", at, entry: b, opId: "op-old" },
			{ type: "entry.merged", at: merged.updatedAt, entry: merged, fromIds: [a.id, b.id], opId: "op-merge" },
		]);

		const preview = undoLastOps(cwd, 1, { dryRun: true });
		expect(preview.opIds).toEqual(["op-merge"]);
		expect(preview.records).toHaveLength(1);
		expect(preview.records[0]?.type).toBe("entry.merged");
		expect(preview.records[0]?.sources?.map((source) => source.content)).toEqual(["Alpha preference", "Beta preference"]);
	});
});
