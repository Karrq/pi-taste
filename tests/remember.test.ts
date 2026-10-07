import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { rememberPreference } = await import("../src/remember.js");
const { foldLedger } = await import("../src/ledger/index.js");
const { readLedger } = await import("../src/ledger/store.js");
const { globalTasteDir, ledgerPath, projectTasteDir } = await import("../src/ledger/paths.js");

const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-remember-"));
	dirs.push(dir);
	agentDir.path = dir;
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("rememberPreference", () => {
	it("records a signal and an explicit entry at full confidence", () => {
		const cwd = "/tmp/pi-taste-remember-a";
		const result = rememberPreference({ cwd, text: "Always use tabs", promoteAtProjectCount: 2 });

		expect(result.entry.confidence).toBe(1);
		expect(result.entry.explicit).toBe(true);
		expect(result.entry.scope).toBe("project");

		const records = readLedger(ledgerPath(projectTasteDir(cwd)));
		expect(records.filter((record) => record.type === "signal.recorded")).toHaveLength(1);
		const folded = foldLedger(records);
		expect(folded.activeEntries).toHaveLength(1);
	});

	it("promotes to global when the same preference is remembered in two projects", () => {
		rememberPreference({ cwd: "/tmp/pi-taste-remember-a", text: "Prefer named exports", promoteAtProjectCount: 2 });
		rememberPreference({ cwd: "/tmp/pi-taste-remember-b", text: "Prefer named exports", promoteAtProjectCount: 2 });

		const global = foldLedger(readLedger(ledgerPath(globalTasteDir())));
		expect(global.activeEntries).toHaveLength(1);
		expect(global.activeEntries[0]?.scope).toBe("global");
		expect(global.activeEntries[0]?.projectKeys).toHaveLength(2);
	});

	it("merges a repeated remember instead of duplicating it", () => {
		const cwd = "/tmp/pi-taste-remember-a";
		rememberPreference({ cwd, text: "Always use tabs", promoteAtProjectCount: 5 });
		rememberPreference({ cwd, text: "always  use TABS.", promoteAtProjectCount: 5 });
		const folded = foldLedger(readLedger(ledgerPath(projectTasteDir(cwd))));
		expect(folded.activeEntries).toHaveLength(1);
	});
});
