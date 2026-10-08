import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { runTasteReflect, normalizeProposals, buildMergedEntry } = await import("../src/reflect.js");
const { Runtime } = await import("../src/runtime.js");
const { DEFAULTS } = await import("../src/config.js");
const { foldLedger, resolveAliasId, tasteEntryId } = await import("../src/ledger/index.js");
const { appendLedger, readLedger } = await import("../src/ledger/store.js");
const { ledgerPath, projectTasteDir } = await import("../src/ledger/paths.js");

import type { TasteEntry } from "../src/ledger/index.js";

const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-reflect-"));
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
		signalIds: ["s"],
		projectKeys: ["--k--"],
		createdAt: at,
		updatedAt: at,
		...overrides,
	};
}

describe("normalizeProposals", () => {
	const a = entry("a");
	const b = entry("b");
	const c = entry("c");
	const known = new Map([[a.id, a], [b.id, b], [c.id, c]]);

	it("drops a proposal that cites an unknown id", () => {
		expect(normalizeProposals([{ fromIds: [a.id, "nope"], content: "x", category: "testing" }], known)).toHaveLength(0);
	});

	it("drops a proposal that reuses an entry already merged", () => {
		const proposals = normalizeProposals(
			[
				{ fromIds: [a.id, b.id], content: "x", category: "testing" },
				{ fromIds: [b.id, c.id], content: "y", category: "testing" },
			],
			known,
		);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]?.fromIds).toEqual([a.id, b.id]);
	});

	it("falls back to general for an unrecognized category", () => {
		const proposals = normalizeProposals([{ fromIds: [a.id, b.id], content: "x", category: "nope" }], known);
		expect(proposals[0]?.category).toBe("general");
	});

	it("collapses multiline content to a single line", () => {
		const proposals = normalizeProposals([{ fromIds: [a.id, b.id], content: "one\ntwo", category: "testing" }], known);
		expect(proposals[0]?.content).toBe("one two");
	});
});

describe("buildMergedEntry", () => {
	it("takes max confidence, unions evidence, and stays explicit if any source was", () => {
		const sources = [
			entry("a", { confidence: 0.6, signalIds: ["s1"], projectKeys: ["k1"] }),
			entry("b", { confidence: 0.9, explicit: true, signalIds: ["s2"], projectKeys: ["k2"] }),
		];
		const merged = buildMergedEntry(
			{ fromIds: sources.map((source) => source.id), content: "Consolidated", category: "testing" },
			sources,
			"2026-03-01T00:00:00.000Z",
		);
		expect(merged.id).toBe(tasteEntryId("Consolidated"));
		expect(merged.confidence).toBe(0.9);
		expect(merged.explicit).toBe(true);
		expect(merged.signalIds.sort()).toEqual(["s1", "s2"]);
		expect(merged.projectKeys.sort()).toEqual(["k1", "k2"]);
	});
});

describe("fold entry.merged", () => {
	it("tombstones sources and aliases them to the merged entry", () => {
		const a = entry("a");
		const b = entry("b");
		const merged = entry("Consolidated");
		const folded = foldLedger([
			{ type: "entry.upserted", at: a.updatedAt, entry: a },
			{ type: "entry.upserted", at: b.updatedAt, entry: b },
			{ type: "entry.merged", at: "2026-03-01T00:00:00.000Z", entry: merged, fromIds: [a.id, b.id] },
		]);
		expect(folded.activeEntries.map((value) => value.id)).toEqual([merged.id]);
		expect(resolveAliasId(folded, a.id)).toBe(merged.id);
		expect(resolveAliasId(folded, b.id)).toBe(merged.id);
	});

	it("resolves a chain of merges to the terminal entry", () => {
		const a = entry("a");
		const first = entry("First");
		const second = entry("Second");
		const folded = foldLedger([
			{ type: "entry.upserted", at: a.updatedAt, entry: a },
			{ type: "entry.merged", at: "2026-02-01T00:00:00.000Z", entry: first, fromIds: [a.id] },
			{ type: "entry.merged", at: "2026-03-01T00:00:00.000Z", entry: second, fromIds: [first.id] },
		]);
		expect(folded.activeEntries.map((value) => value.id)).toEqual([second.id]);
		expect(resolveAliasId(folded, a.id)).toBe(second.id);
	});
});

describe("runTasteReflect", () => {
	function harness(cwd: string, entries: TasteEntry[], maxEntries = 60) {
		appendLedger(
			ledgerPath(projectTasteDir(cwd)),
			entries.map((value) => ({ type: "entry.upserted" as const, at: value.updatedAt, entry: value })),
		);
		const runtime = new Runtime();
		runtime.config = { ...DEFAULTS, reflectMaxEntries: maxEntries };
		runtime.configLoaded = true;
		return runtime;
	}

	it("writes one merged entry and tombstones the sources", async () => {
		const cwd = "/tmp/pi-taste-reflect-a";
		const a = entry("Prefers named exports", { category: "typescript", confidence: 0.6 });
		const b = entry("Avoids default exports", { category: "typescript", confidence: 0.8 });
		const runtime = harness(cwd, [a, b]);

		const summary = await runTasteReflect(
			runtime,
			{ cwd, model: {}, modelRegistry: {} },
			{
				resolveModel: async () => ({ model: {} }),
				runReflection: async () => [
					{ fromIds: [a.id, b.id], content: "Prefer named exports over default exports", category: "typescript" },
				],
			},
		);

		expect(summary).toEqual({ entriesConsidered: 2, merged: 1, entriesRetracted: 2, truncated: false });
		const folded = foldLedger(readLedger(ledgerPath(projectTasteDir(cwd))));
		expect(folded.activeEntries).toHaveLength(1);
		expect(folded.activeEntries[0]?.content).toBe("Prefer named exports over default exports");
		expect(folded.activeEntries[0]?.confidence).toBe(0.8);
		expect(resolveAliasId(folded, a.id)).toBe(folded.activeEntries[0]?.id);
	});

	it("does not tombstone a source whose wording becomes the merged statement", async () => {
		const cwd = "/tmp/pi-taste-reflect-b";
		const a = entry("Always use tabs", { category: "formatting" });
		const b = entry("Never use spaces for indentation", { category: "formatting" });
		const runtime = harness(cwd, [a, b]);

		const summary = await runTasteReflect(
			runtime,
			{ cwd, model: {}, modelRegistry: {} },
			{
				resolveModel: async () => ({ model: {} }),
				runReflection: async () => [{ fromIds: [a.id, b.id], content: "Always use tabs", category: "formatting" }],
			},
		);

		expect(summary.entriesRetracted).toBe(1);
		const folded = foldLedger(readLedger(ledgerPath(projectTasteDir(cwd))));
		expect(folded.activeEntries).toHaveLength(1);
		expect(folded.activeEntries[0]?.id).toBe(a.id);
	});

	it("caps the pool at reflectMaxEntries and reports truncation", async () => {
		const cwd = "/tmp/pi-taste-reflect-c";
		const entries = [entry("a"), entry("b"), entry("c")];
		const runtime = harness(cwd, entries, 2);
		let seen = 0;

		const summary = await runTasteReflect(
			runtime,
			{ cwd, model: {}, modelRegistry: {} },
			{
				resolveModel: async () => ({ model: {} }),
				runReflection: async (args) => {
					seen = args.entries.length;
					return undefined;
				},
			},
		);

		expect(seen).toBe(2);
		expect(summary.truncated).toBe(true);
		expect(summary.merged).toBe(0);
	});
});
