import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { exportTasteMarkdown } = await import("../src/export.js");
const { tasteEntryId } = await import("../src/ledger/index.js");
const { appendLedger } = await import("../src/ledger/store.js");
const { globalTasteDir, ledgerPath, projectTasteDir } = await import("../src/ledger/paths.js");

import type { TasteEntry } from "../src/ledger/index.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

beforeEach(() => {
	agentDir.path = tempDir("pi-taste-export-agent-");
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

describe("exportTasteMarkdown", () => {
	it("writes taste.md into the working directory and nothing into the ledger dirs", () => {
		const cwd = tempDir("pi-taste-export-cwd-");
		appendLedger(ledgerPath(projectTasteDir(cwd)), [
			{ type: "entry.upserted", at: "2026-01-01T00:00:00.000Z", entry: entry("Always use tabs") },
		]);
		appendLedger(ledgerPath(globalTasteDir()), [
			{ type: "entry.upserted", at: "2026-01-01T00:00:00.000Z", entry: entry("Prefer named exports", { scope: "global" }) },
		]);

		const result = exportTasteMarkdown(cwd);

		expect(result.path).toBe(join(cwd, "taste.md"));
		expect(result.projectCount).toBe(1);
		expect(result.globalCount).toBe(1);
		const text = readFileSync(result.path, "utf-8");
		expect(text).toContain("Always use tabs");
		expect(text).toContain("Prefer named exports");
		expect(existsSync(join(projectTasteDir(cwd), "taste.md"))).toBe(false);
		expect(existsSync(join(globalTasteDir(), "taste.md"))).toBe(false);
	});
});
