import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import { ConsolidationLoader, formatEntryLine, helpText, parseCategoryArgs, progressMessage, subcommandCompletions, viewText } from "../src/commands/taste.js";
import { Runtime } from "../src/runtime.js";
import { tasteEntryId, type TasteEntry } from "../src/ledger/index.js";
import { appendLedger } from "../src/ledger/store.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "../src/ledger/paths.js";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-view-"));
	dirs.push(dir);
	agentDir.path = dir;
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(content: string, category: string, scope: "project" | "global"): TasteEntry {
	const at = "2026-01-01T00:00:00.000Z";
	return {
		id: tasteEntryId(content),
		content,
		category,
		confidence: 0.7,
		explicit: true,
		scope,
		signalIds: [],
		projectKeys: [],
		createdAt: at,
		updatedAt: at,
	};
}

describe("taste subcommand completions", () => {
	it("returns every subcommand for an empty prefix", () => {
		const items = subcommandCompletions("");
		expect(items?.map((item) => item.value)).toContain("status");
		expect(items?.map((item) => item.value)).toContain("remember");
		expect(items?.map((item) => item.value)).toContain("help");
	});

	it("returns every subcommand for a bare space, so /taste <tab> previews them", () => {
		expect(subcommandCompletions(" ")?.length).toBeGreaterThan(0);
	});

	it("filters by prefix, case-insensitively", () => {
		expect(subcommandCompletions("rem")?.map((item) => item.value)).toEqual(["remember"]);
		expect(subcommandCompletions("CO")?.map((item) => item.value)).toEqual(["consolidate"]);
	});

	it("still offers a unique match after the typo case is narrowed", () => {
		expect(subcommandCompletions("en")?.map((item) => item.value)).toEqual(["enable"]);
	});

	it("carries a description for each candidate", () => {
		for (const item of subcommandCompletions("") ?? []) {
			expect(item.description).toBeTruthy();
		}
	});

	it("stops completing once the first token is followed by an argument", () => {
		expect(subcommandCompletions("remember always use tabs")).toBeNull();
	});

	it("returns null when nothing matches", () => {
		expect(subcommandCompletions("zzz")).toBeNull();
	});
});

describe("taste help text", () => {
	it("lists every subcommand with its usage", () => {
		const text = helpText();
		expect(text).toContain("remember <text>");
		expect(text).toContain("forget <text | id:...>");
		expect(text).toContain("promote <text | id:...>");
		expect(text).toContain("enable [--project]");
	});

	it("starts with a usage header", () => {
		expect(helpText().split("\n")[0]).toBe("taste: usage");
	});
});

const tui = { requestRender: () => {} } as unknown as TUI;

// The loader only needs theme.fg; a passthrough is enough for a render smoke test.
const fakeTheme = { fg: (_color: string, text: string) => text } as unknown as ConstructorParameters<typeof ConsolidationLoader>[1];

describe("category argument parsing", () => {
	it("treats the trailing token as the category and the rest as the selector", () => {
		expect(parseCategoryArgs(["always", "use", "tabs", "formatting"])).toEqual({
			target: "always use tabs",
			category: "formatting",
		});
	});

	it("accepts an id: selector", () => {
		expect(parseCategoryArgs(["id:abc123", "testing"])).toEqual({ target: "id:abc123", category: "testing" });
	});

	it("rejects a missing category", () => {
		expect(parseCategoryArgs(["always use tabs"])).toHaveProperty("error");
	});

	it("rejects an unknown category and lists the known ones", () => {
		const parsed = parseCategoryArgs(["always use tabs", "nonsense"]);
		expect(parsed).toHaveProperty("error");
		if ("error" in parsed) expect(parsed.error).toContain("formatting");
	});

	it("accepts a user-defined category that is in the provided vocabulary", () => {
		expect(parseCategoryArgs(["use react", "frontend"], ["formatting", "frontend"])).toEqual({
			target: "use react",
			category: "frontend",
		});
	});

	it("rejects a category outside the provided vocabulary", () => {
		expect(parseCategoryArgs(["use react", "frontend"], ["formatting"])).toHaveProperty("error");
	});
});

describe("view formatting", () => {
	it("prefixes each line with a usable id: selector", () => {
		const line = formatEntryLine({
			id: "abc123def456",
			content: "Always use tabs",
			category: "formatting",
			confidence: 0.8,
			explicit: true,
			scope: "project",
			signalIds: [],
			projectKeys: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(line).toBe("id:abc123def456 80% [formatting] Always use tabs");
	});

	it("separates project and global entries into labelled sections", () => {
		const cwd = "/tmp/pi-taste-view";
		const project = entry("Project preference", "general", "project");
		const global = entry("Global preference", "workflow", "global");
		appendLedger(ledgerPath(projectTasteDir(cwd)), [{ type: "entry.upserted", at: project.updatedAt, entry: project }]);
		appendLedger(ledgerPath(globalTasteDir()), [{ type: "entry.upserted", at: global.updatedAt, entry: global }]);

		const text = viewText(new Runtime(), cwd);
		expect(text).toContain("project (1)");
		expect(text).toContain("global (1)");
		expect(text.indexOf("project (1)")).toBeLessThan(text.indexOf("global (1)"));
		expect(text).toContain(`id:${project.id}`);
		expect(text).toContain(`id:${global.id}`);
	});

	it("omits a layer with no entries", () => {
		const cwd = "/tmp/pi-taste-view-empty";
		expect(viewText(new Runtime(), cwd)).toBe("taste: no entries yet");
	});

	it("hides a project row that is also global and counts it", () => {
		const cwd = "/tmp/pi-taste-view-dup";
		const shared = entry("Shared preference", "general", "project");
		const localOnly = entry("Local only", "tooling", "project");
		const sharedGlobal = { ...shared, scope: "global" as const };
		appendLedger(ledgerPath(projectTasteDir(cwd)), [
			{ type: "entry.upserted", at: shared.updatedAt, entry: shared },
			{ type: "entry.upserted", at: localOnly.updatedAt, entry: localOnly },
		]);
		appendLedger(ledgerPath(globalTasteDir()), [
			{ type: "entry.upserted", at: sharedGlobal.updatedAt, entry: sharedGlobal },
		]);

		const text = viewText(new Runtime(), cwd);
		expect(text).toContain("project (2)");
		expect(text).toContain("global (1)");
		expect(text).toContain("1 more entry also promoted to global");
		expect(text).toContain(localOnly.id);
		expect(text.split(`id:${shared.id}`).length - 1).toBe(1);
	});
});

describe("consolidate loader", () => {
	it("renders bordered lines and survives a message update", () => {
		const loader = new ConsolidationLoader(tui, fakeTheme, "taste: consolidating…", () => {});
		const before = loader.render(60);
		expect(before.length).toBeGreaterThan(1);
		loader.setMessage("taste: extracting chunk 2 of 8");
		const after = loader.render(60).join("\n");
		expect(after).toContain("extracting chunk 2 of 8");
		loader.dispose();
	});

	it("invokes the cancel callback once on escape", () => {
		let cancelled = 0;
		const loader = new ConsolidationLoader(tui, fakeTheme, "taste: consolidating…", () => cancelled++);
		loader.handleInput("\u001b");
		loader.handleInput("\u001b");
		expect(cancelled).toBe(1);
		loader.dispose();
	});

	it("formats extract and prune progress", () => {
		expect(progressMessage({ stage: "extract", chunk: 2, maxChunks: 8, signals: 1, entries: 0 })).toBe(
			"taste: extracting chunk 2 of 8 — 1 signal, 0 entries",
		);
		expect(progressMessage({ stage: "prune", chunk: 3, maxChunks: 8, signals: 4, entries: 2 })).toBe(
			"taste: merging and pruning — 4 signals, 2 entries",
		);
	});
});
