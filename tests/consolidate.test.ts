import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { runTasteConsolidation } = await import("../src/consolidate.js");
const { Runtime } = await import("../src/runtime.js");
const { DEFAULTS } = await import("../src/config.js");
const { hashId } = await import("../src/ids.js");
const { normalizeTasteContent } = await import("../src/ledger/index.js");
const { ledgerPath, projectTasteDir } = await import("../src/ledger/paths.js");
const { readLedger } = await import("../src/ledger/store.js");
const { TASTE_COVERAGE } = await import("../src/session/coverage.js");

import type { SessionEntry } from "../src/session/types.js";
import type { Signal } from "../src/ledger/index.js";

const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-consolidate-"));
	dirs.push(dir);
	agentDir.path = dir;
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function message(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	};
}

function signal(content: string, sourceEntryIds: string[]): Signal {
	return {
		id: hashId(normalizeTasteContent(content)),
		content,
		timestamp: "2026-01-01 00:00",
		kind: "stated",
		projectKey: "k",
		sourceEntryIds,
	};
}

interface Harness {
	pi: ExtensionAPI;
	appended: Array<{ customType: string; data: unknown }>;
	runtime: InstanceType<typeof Runtime>;
	ctx: Parameters<typeof runTasteConsolidation>[2];
}

function harness(entries: SessionEntry[], config: Partial<InstanceType<typeof Runtime>["config"]> = {}): Harness {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const runtime = new Runtime();
	runtime.config = { ...DEFAULTS, enabled: true, extractChunkMaxTokens: 100_000, ...config };
	runtime.configLoaded = true;
	const ctx = {
		cwd: "/tmp/taste-project",
		hasUI: false,
		model: { provider: "test", id: "test" },
		modelRegistry: {},
		sessionManager: { getBranch: () => entries },
	} as unknown as Parameters<typeof runTasteConsolidation>[2];
	return { pi, appended, runtime, ctx };
}

describe("runTasteConsolidation", () => {
	it("drains the branch, writes signals, and advances coverage", async () => {
		const entries = [message("m1", "always use tabs"), message("m2", "never use default exports")];
		const { pi, appended, runtime, ctx } = harness(entries);
		ctx.opId = "op-test";

		const summary = await runTasteConsolidation(pi, runtime, ctx, {
			resolveModel: async () => ({ model: {} }),
			runExtraction: async (args) => [signal("Always use tabs", [args.allowedSourceEntryIds[0]])],
		});

		expect(summary).toEqual({ chunks: 1, signalsRecorded: 1, entriesUpserted: 1, entriesRetracted: 0, reachedEnd: true });
		expect(appended).toHaveLength(1);
		expect(appended[0]?.customType).toBe(TASTE_COVERAGE);
		expect((appended[0]?.data as { coversUpToId: string }).coversUpToId).toBe("m2");
		expect((appended[0]?.data as { opId?: string }).opId).toBe("op-test");
		const records = readLedger(ledgerPath(projectTasteDir(ctx.cwd)));
		expect(records.filter((record) => record.type === "signal.recorded")).toHaveLength(1);
		expect(records.every((record) => record.opId === "op-test")).toBe(true);
	});

	it("stops at the chunk cap and reports that more remain", async () => {
		const entries = [message("m1", "always use tabs"), message("m2", "never use default exports")];
		const { pi, runtime, ctx } = harness(entries, { consolidateMaxChunks: 1, extractChunkMaxTokens: 20 });

		const summary = await runTasteConsolidation(pi, runtime, ctx, {
			resolveModel: async () => ({ model: {} }),
			runExtraction: async (args) => [signal("Always use tabs", [args.allowedSourceEntryIds[0]])],
		});

		expect(summary.chunks).toBe(1);
		expect(summary.reachedEnd).toBe(false);
	});

	it("advances coverage even when a chunk yields no signals", async () => {
		const entries = [message("m1", "hello there")];
		const { pi, appended, runtime, ctx } = harness(entries);

		const summary = await runTasteConsolidation(pi, runtime, ctx, {
			resolveModel: async () => ({ model: {} }),
			runExtraction: async () => undefined,
		});

		expect(summary).toEqual({ chunks: 1, signalsRecorded: 0, entriesUpserted: 0, entriesRetracted: 0, reachedEnd: true });
		expect(appended).toHaveLength(1);
		expect((appended[0]?.data as { signalCount: number }).signalCount).toBe(0);
	});
});
