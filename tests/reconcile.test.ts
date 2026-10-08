import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { combineConfidence, reconcileCandidate } = await import("../src/reconcile.js");
const { appendLedger } = await import("../src/ledger/store.js");
const { encodeCwd, ledgerPath, projectTasteDir } = await import("../src/ledger/paths.js");
const { tasteEntryId } = await import("../src/ledger/types.js");
const { foldLedger } = await import("../src/ledger/fold.js");
const { readLedger } = await import("../src/ledger/store.js");

import type { LedgerRecord, Signal, TasteEntry } from "../src/ledger/index.js";
import type { DistilledCandidate } from "../src/agents/distill/index.js";

const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-reconcile-"));
	dirs.push(dir);
	agentDir.path = dir;
});

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
		signalIds: ["s0"],
		projectKeys: ["k"],
		createdAt: at,
		updatedAt: at,
		...overrides,
	};
}

function candidate(content: string, overrides: Partial<DistilledCandidate> = {}): DistilledCandidate {
	const signal: Signal = {
		id: "s1",
		content,
		timestamp: "2026-01-01 00:00",
		kind: "stated",
		projectKey: "k",
		sourceEntryIds: ["m1"],
	};
	return {
		content,
		category: "formatting",
		confidence: 0.6,
		explicit: false,
		general: false,
		signal,
		...overrides,
	};
}

function writeProjectEntry(cwd: string, value: TasteEntry): void {
	const record: LedgerRecord = { type: "entry.upserted", at: value.updatedAt, entry: value };
	appendLedger(ledgerPath(projectTasteDir(cwd)), [record]);
}

describe("combineConfidence", () => {
	it("is a probabilistic OR with diminishing returns", () => {
		expect(combineConfidence(undefined, 0.6)).toBe(0.6);
		expect(combineConfidence(0.6, 0.6)).toBeCloseTo(0.84, 5);
	});
});

describe("reconcileCandidate", () => {
	it("merges a recurring preference and raises confidence", () => {
		const cwd = "/tmp/pi-taste-proj-a";
		const projectKey = encodeCwd(cwd);
		writeProjectEntry(cwd, entry("Always use tabs", { projectKeys: [projectKey] }));

		const result = reconcileCandidate({
			cwd,
			candidate: candidate("Always use tabs"),
			projectKey,
			promoteAtProjectCount: 5,
			now: "2026-01-02T00:00:00.000Z",
		});

		expect(result.entry.confidence).toBeCloseTo(0.84, 5);
		expect(result.entry.signalIds).toEqual(["s0", "s1"]);
		expect(result.globalRecords).toHaveLength(0);
	});

	it("promotes to global once the preference spans two projects", () => {
		const cwdA = "/tmp/pi-taste-proj-a";
		const keyA = encodeCwd(cwdA);
		writeProjectEntry(cwdA, entry("Prefer named exports", { projectKeys: [keyA] }));

		const cwdB = "/tmp/pi-taste-proj-b";
		const keyB = encodeCwd(cwdB);
		const result = reconcileCandidate({
			cwd: cwdB,
			candidate: candidate("Prefer named exports"),
			projectKey: keyB,
			promoteAtProjectCount: 2,
			now: "2026-01-02T00:00:00.000Z",
		});

		expect(result.globalRecords).toHaveLength(1);
		expect(result.globalRecords[0]?.type).toBe("entry.upserted");
		const globalEntry = (result.globalRecords[0] as { entry: TasteEntry }).entry;
		expect(globalEntry.scope).toBe("global");
		expect(globalEntry.projectKeys.sort()).toEqual([keyA, keyB].sort());
	});

	it("promotes immediately when the classifier judged the preference general", () => {
		const cwd = "/tmp/pi-taste-proj-c";
		const projectKey = encodeCwd(cwd);
		const result = reconcileCandidate({
			cwd,
			candidate: candidate("Answer without preamble", { general: true }),
			projectKey,
			promoteAtProjectCount: 5,
			now: "2026-01-02T00:00:00.000Z",
		});
		expect(result.globalRecords).toHaveLength(1);
	});

	it("redirects a re-observed phrasing onto the consolidated entry", () => {
		const cwd = "/tmp/pi-taste-proj-merge";
		const projectKey = encodeCwd(cwd);
		const source = entry("Use tabs always", { confidence: 0.6, projectKeys: [projectKey], signalIds: ["s0"] });
		const merged = entry("Always use tabs", { confidence: 0.7, projectKeys: [projectKey], signalIds: ["s0"] });
		appendLedger(ledgerPath(projectTasteDir(cwd)), [
			{ type: "entry.upserted", at: source.updatedAt, entry: source },
			{ type: "entry.merged", at: "2026-01-02T00:00:00.000Z", entry: merged, fromIds: [source.id] },
		]);

		const result = reconcileCandidate({
			cwd,
			candidate: candidate("Use tabs always"),
			projectKey,
			promoteAtProjectCount: 5,
			now: "2026-01-03T00:00:00.000Z",
		});

		expect(result.entry.id).toBe(merged.id);
		expect(result.entry.content).toBe("Always use tabs");
		expect(result.entry.signalIds).toEqual(["s0", "s1"]);
		expect(result.entry.confidence).toBeCloseTo(0.88, 5);
	});

	it("persists the merged entry so a rerun sees it", () => {
		const cwd = "/tmp/pi-taste-proj-d";
		const projectKey = encodeCwd(cwd);
		const first = reconcileCandidate({
			cwd,
			candidate: candidate("Always use tabs"),
			projectKey,
			promoteAtProjectCount: 5,
			now: "2026-01-02T00:00:00.000Z",
		});
		appendLedger(ledgerPath(projectTasteDir(cwd)), first.projectRecords);
		const folded = foldLedger(readLedger(ledgerPath(projectTasteDir(cwd))));
		expect(folded.activeEntries).toHaveLength(1);
	});
});
