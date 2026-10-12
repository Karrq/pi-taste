import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { TasteEntry } from "../src/ledger/index.js";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { Runtime } = await import("../src/runtime.js");
const { DEFAULTS } = await import("../src/config.js");
const { refreshTasteSnapshot, syncTasteSnapshot, TASTE_SNAPSHOT_ENTRY, registerTasteSnapshotRenderer, TasteSnapshotCard } = await import(
	"../src/taste-snapshot.js"
);
const { tasteEntryId } = await import("../src/ledger/index.js");
const { appendLedger } = await import("../src/ledger/store.js");
const { globalTasteDir, ledgerPath, projectTasteDir } = await import("../src/ledger/paths.js");

const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-snapshot-"));
	dirs.push(dir);
	agentDir.path = dir;
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Appended {
	customType: string;
	data: unknown;
}

function fakePi(appended: Appended[]): ExtensionAPI {
	return {
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ customType, data });
		},
		registerEntryRenderer: () => {},
	} as unknown as ExtensionAPI;
}

function runtime(enabled: boolean): InstanceType<typeof Runtime> {
	const value = new Runtime();
	value.config = { ...DEFAULTS, enabled };
	value.configLoaded = true;
	return value;
}

function entry(content: string, scope: "project" | "global", confidence = 0.7): TasteEntry {
	const at = "2026-01-01T00:00:00.000Z";
	return {
		id: tasteEntryId(content),
		content,
		category: "general",
		confidence,
		explicit: true,
		scope,
		signalIds: [],
		projectKeys: [],
		createdAt: at,
		updatedAt: at,
	};
}

function seed(cwd: string, project: TasteEntry[], global: TasteEntry[]): void {
	const record = (value: TasteEntry) => ({ type: "entry.upserted" as const, at: value.updatedAt, entry: value });
	appendLedger(ledgerPath(projectTasteDir(cwd)), project.map(record));
	appendLedger(ledgerPath(globalTasteDir()), global.map(record));
}

describe("refreshTasteSnapshot", () => {
	it("reports a change on the first build and none on an identical rebuild", () => {
		const cwd = "/tmp/pi-taste-snapshot-a";
		seed(cwd, [entry("Project pref", "project")], [entry("Global pref", "global")]);
		const rt = runtime(true);

		const first = refreshTasteSnapshot(rt, cwd);
		expect(first.changed).toBe(true);
		expect(first.projectCount).toBe(1);
		expect(first.globalCount).toBe(1);
		expect(first.section).toContain("<taste>");

		const second = refreshTasteSnapshot(rt, cwd);
		expect(second.changed).toBe(false);
	});

	it("reports a change when the injected text changes", () => {
		const cwd = "/tmp/pi-taste-snapshot-b";
		seed(cwd, [entry("Project pref", "project")], []);
		const rt = runtime(true);
		refreshTasteSnapshot(rt, cwd);

		appendLedger(ledgerPath(globalTasteDir()), [
			{ type: "entry.upserted", at: "2026-01-02T00:00:00.000Z", entry: entry("Global pref", "global") },
		]);
		const result = refreshTasteSnapshot(rt, cwd);
		expect(result.changed).toBe(true);
		expect(result.globalCount).toBe(1);
	});

	it("does not report a change for an entry below the injection floor", () => {
		const cwd = "/tmp/pi-taste-snapshot-c";
		seed(cwd, [entry("Project pref", "project")], []);
		const rt = runtime(true);
		refreshTasteSnapshot(rt, cwd);

		appendLedger(ledgerPath(projectTasteDir(cwd)), [
			{ type: "entry.upserted", at: "2026-01-02T00:00:00.000Z", entry: entry("Too weak", "project", 0.1) },
		]);
		expect(refreshTasteSnapshot(rt, cwd).changed).toBe(false);
	});
});

describe("syncTasteSnapshot", () => {
	it("appends one entry per change with a summary and the full block", () => {
		const cwd = "/tmp/pi-taste-snapshot-d";
		seed(cwd, [entry("Project pref", "project")], [entry("Global pref", "global")]);
		const appended: Appended[] = [];
		const pi = fakePi(appended);
		const rt = runtime(true);

		syncTasteSnapshot(pi, rt, cwd);
		expect(appended).toHaveLength(1);
		expect(appended[0]?.customType).toBe(TASTE_SNAPSHOT_ENTRY);
		const data = appended[0]?.data as { summary: string; block?: string };
		expect(data.summary).toBe("loaded 1 project preference and 1 global preference");
		expect(data.block).toContain("<taste>");
		expect(data.block).toContain("Project pref");

		syncTasteSnapshot(pi, rt, cwd);
		expect(appended).toHaveLength(1);
	});

	it("appends again after the ledger changes", () => {
		const cwd = "/tmp/pi-taste-snapshot-e";
		seed(cwd, [entry("Project pref", "project")], []);
		const appended: Appended[] = [];
		const pi = fakePi(appended);
		const rt = runtime(true);

		syncTasteSnapshot(pi, rt, cwd);
		expect(appended).toHaveLength(1);

		appendLedger(ledgerPath(projectTasteDir(cwd)), [
			{ type: "entry.upserted", at: "2026-01-02T00:00:00.000Z", entry: entry("Second pref", "project") },
		]);
		syncTasteSnapshot(pi, rt, cwd);
		expect(appended).toHaveLength(2);
		expect((appended[1]?.data as { summary: string }).summary).toBe(
			"loaded 2 project preferences and 0 global preferences",
		);
	});

	it("appends nothing while taste is disabled", () => {
		const cwd = "/tmp/pi-taste-snapshot-f";
		seed(cwd, [entry("Project pref", "project")], []);
		const appended: Appended[] = [];
		const rt = runtime(false);

		syncTasteSnapshot(fakePi(appended), rt, cwd);
		expect(appended).toHaveLength(0);
		expect(rt.tasteSnapshot).toBeUndefined();
	});

	it("appends a disabled entry when taste turns off", () => {
		const cwd = "/tmp/pi-taste-snapshot-g";
		seed(cwd, [entry("Project pref", "project")], []);
		const appended: Appended[] = [];
		const pi = fakePi(appended);
		const rt = runtime(true);

		syncTasteSnapshot(pi, rt, cwd);
		expect(appended).toHaveLength(1);

		rt.config.enabled = false;
		syncTasteSnapshot(pi, rt, cwd);
		expect(appended).toHaveLength(2);
		const data = appended[1]?.data as { summary: string; enabled: boolean; block?: string };
		expect(data.summary).toBe("disabled");
		expect(data.enabled).toBe(false);
		expect(data.block).toBeUndefined();

		syncTasteSnapshot(pi, rt, cwd);
		expect(appended).toHaveLength(2);
	});
});

describe("registerTasteSnapshotRenderer", () => {
	it("registers a renderer for the snapshot entry type", () => {
		let registeredType: string | undefined;
		const pi = {
			registerEntryRenderer: (customType: string) => {
				registeredType = customType;
			},
		} as unknown as ExtensionAPI;

		registerTasteSnapshotRenderer(pi);
		expect(registeredType).toBe(TASTE_SNAPSHOT_ENTRY);
	});
});

describe("TasteSnapshotCard", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		bg: (_color: string, text: string) => text,
	} as unknown as Theme;

	const data = { summary: "loaded 1 project preference and 1 global preference", enabled: true, projectCount: 1, globalCount: 1, block: "<taste>\n- Always use tabs\n</taste>" };

	it("shows the title and detail line when collapsed", () => {
		const card = new TasteSnapshotCard(data, theme, false);
		const text = card.render(80).join("\n");
		expect(text).toContain("taste");
		expect(text).toContain("loaded 1 project preference and 1 global preference");
		expect(text).not.toContain("Always use tabs");
	});

	it("shows the full block when expanded", () => {
		const card = new TasteSnapshotCard(data, theme, true);
		const text = card.render(80).join("\n");
		expect(text).toContain("Always use tabs");
	});

	it("expands on left click", () => {
		const card = new TasteSnapshotCard(data, theme, false);
		const collapsed = card.render(80);
		expect(collapsed.join("\n")).not.toContain("Always use tabs");

		const result = card.handleMouse({
			type: "click",
			button: "left",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 80,
			height: collapsed.length,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(result?.handled).toBe(true);
		expect(card.render(80).join("\n")).toContain("Always use tabs");
	});

	it("ignores non-left clicks", () => {
		const card = new TasteSnapshotCard(data, theme, false);
		const collapsed = card.render(80);
		const result = card.handleMouse({
			type: "click",
			button: "right",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 80,
			height: collapsed.length,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(result).toBeUndefined();
		expect(card.render(80).join("\n")).not.toContain("Always use tabs");
	});

	it("explains when nothing was injected", () => {
		const card = new TasteSnapshotCard({ ...data, block: undefined }, theme, true);
		const text = card.render(80).join("\n");
		expect(text).toContain("no entries above the confidence floor");
	});
});
