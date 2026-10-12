import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { runTasteReflect } = await import("../src/reflect.js");
const { runTastePrune } = await import("../src/prune.js");
const { Runtime } = await import("../src/runtime.js");
const { DEFAULTS } = await import("../src/config.js");
const { foldLedger, tasteEntryId } = await import("../src/ledger/index.js");
const { appendLedger, readLedger } = await import("../src/ledger/store.js");
const { globalTasteDir, ledgerPath, projectTasteDir } = await import("../src/ledger/paths.js");

import type { TasteEntry } from "../src/ledger/index.js";

const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-scope-"));
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
		category: "workflow",
		confidence: 0.5,
		explicit: true,
		scope: "global",
		signalIds: ["s"],
		projectKeys: ["--k--"],
		createdAt: at,
		updatedAt: at,
		...overrides,
	};
}

function runtime(): InstanceType<typeof Runtime> {
	const value = new Runtime();
	value.config = { ...DEFAULTS };
	value.configLoaded = true;
	return value;
}

function seedGlobal(entries: TasteEntry[]): void {
	appendLedger(
		ledgerPath(globalTasteDir()),
		entries.map((value) => ({ type: "entry.upserted" as const, at: value.updatedAt, entry: value })),
	);
}

describe("global scope", () => {
	it("reflects the global ledger and writes global-scoped merges", async () => {
		const cwd = "/tmp/pi-taste-scope-a";
		const a = entry("Work on a branch in a git worktree");
		const b = entry("Do feature work on a branch in a git worktree");
		seedGlobal([a, b]);

		const summary = await runTasteReflect(
			runtime(),
			{ cwd, model: {}, modelRegistry: {}, scope: "global" },
			{
				resolveModel: async () => ({ model: {} }),
				runReflection: async () => [
					{ fromIds: [a.id, b.id], content: "Use a git worktree branch for feature work", category: "workflow" },
				],
			},
		);

		expect(summary.merged).toBe(1);
		const folded = foldLedger(readLedger(ledgerPath(globalTasteDir())));
		expect(folded.activeEntries).toHaveLength(1);
		expect(folded.activeEntries[0]?.scope).toBe("global");
		expect(readLedger(ledgerPath(projectTasteDir(cwd)))).toHaveLength(0);
	});

	it("leaves the project ledger untouched when reflecting global", async () => {
		const cwd = "/tmp/pi-taste-scope-b";
		const a = entry("Project preference", { scope: "project", category: "general" });
		appendLedger(ledgerPath(projectTasteDir(cwd)), [
			{ type: "entry.upserted", at: a.updatedAt, entry: a },
		]);
		seedGlobal([entry("Global preference")]);

		await runTasteReflect(
			runtime(),
			{ cwd, model: {}, modelRegistry: {}, scope: "global" },
			{ resolveModel: async () => ({ model: {} }), runReflection: async () => undefined },
		);

		expect(foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries).toHaveLength(1);
	});

	it("prunes the global ledger when scope is global", async () => {
		const cwd = "/tmp/pi-taste-scope-c";
		const low = entry("Low confidence global preference", { explicit: false, confidence: 0.2 });
		seedGlobal([low]);

		const result = await runTastePrune(runtime(), { cwd, modelRegistry: {}, scope: "global" });

		expect(result.total).toBe(1);
		expect(result.retractions.map((value) => value.entryId)).toEqual([low.id]);
		const folded = foldLedger(readLedger(ledgerPath(globalTasteDir())));
		expect(folded.activeEntries).toHaveLength(0);
		expect(readLedger(ledgerPath(projectTasteDir(cwd)))).toHaveLength(0);
	});
});
