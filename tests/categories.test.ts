import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentDir = { path: "" };

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.path,
}));

const { loadConfig, ensureTasteSettings, defaultTasteSettings, DEFAULT_CATEGORIES } = await import("../src/config.js");
const { buildDistillQuestions, questionKey } = await import("../src/agents/distill/questions.js");

const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-taste-categories-"));
	dirs.push(dir);
	agentDir.path = join(dir, "agent");
	mkdirSync(agentDir.path, { recursive: true });
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-taste-project-"));
	dirs.push(cwd);
	return cwd;
}

function projectWithCategories(categories: unknown): string {
	return projectWithTaste({ categories });
}

function projectWithTaste(taste: unknown): string {
	const cwd = freshCwd();
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ taste }));
	return cwd;
}

function readTaste(): Record<string, unknown> {
	const path = join(agentDir.path, "settings.json");
	const raw = JSON.parse(readFileSync(path, "utf-8")) as { taste: Record<string, unknown> };
	return raw.taste;
}

const EXPECTED_CATEGORIES = [
	"formatting",
	"naming",
	"architecture",
	"typescript",
	"python",
	"testing",
	"error-handling",
	"tooling",
	"dependencies",
	"api-design",
	"workflow",
	"communication",
	"general",
];

describe("DEFAULT_CATEGORIES", () => {
	it("is the shipped default set", () => {
		expect(Object.keys(DEFAULT_CATEGORIES)).toEqual(EXPECTED_CATEGORIES);
	});
});

describe("defaultTasteSettings", () => {
	it("carries every config key at its default", () => {
		const settings = defaultTasteSettings();
		expect(Object.keys(settings).sort()).toEqual([
			"agentMaxTokens",
			"agentMaxTurns",
			"categories",
			"classifier",
			"consolidateMaxChunks",
			"debugLog",
			"enabled",
			"injectionConfidenceFloor",
			"maxInjectedTokens",
			"modelMap",
			"passive",
			"promoteAtProjectCount",
			"pruneConfidenceFloor",
			"reflectMaxEntries",
		]);
		expect(settings.categories).toEqual(DEFAULT_CATEGORIES);
	});
});

describe("ensureTasteSettings", () => {
	it("writes a full config on first use", () => {
		const cwd = freshCwd();
		const filled = ensureTasteSettings(cwd);
		expect(join(agentDir.path, "settings.json")).toBeTruthy();
		const onDisk = readTaste();
		expect(onDisk).toEqual(filled);
		expect(onDisk.categories).toEqual(DEFAULT_CATEGORIES);
		expect((onDisk.classifier as Record<string, unknown>).mode).toBe("shadow");
		expect(onDisk.enabled).toBe(false);
	});

	it("fills missing keys in a partial block without overwriting existing values", () => {
		writeFileSync(
			join(agentDir.path, "settings.json"),
			JSON.stringify({
				taste: { classifier: { mode: "primary", provider: "local-jev" } },
				other: { kept: true },
			}),
		);
		const filled = ensureTasteSettings(freshCwd());
		const classifier = filled.classifier as Record<string, unknown>;
		expect(classifier.mode).toBe("primary");
		expect(classifier.provider).toBe("local-jev");
		expect(classifier.requestTimeoutMs).toBe(60_000);
		expect(filled.categories).toEqual(DEFAULT_CATEGORIES);
		// Unrelated top-level keys survive.
		const raw = JSON.parse(readFileSync(join(agentDir.path, "settings.json"), "utf-8")) as { other: unknown };
		expect(raw.other).toEqual({ kept: true });
	});

	it("is idempotent once the block is full", () => {
		const cwd = freshCwd();
		ensureTasteSettings(cwd);
		const before = readFileSync(join(agentDir.path, "settings.json"), "utf-8");
		ensureTasteSettings(cwd);
		const after = readFileSync(join(agentDir.path, "settings.json"), "utf-8");
		expect(after).toBe(before);
	});
});

describe("loadConfig categories", () => {
	it("seeds the full default config and returns the default categories", () => {
		const cwd = freshCwd();
		expect(loadConfig(cwd).categories).toEqual(DEFAULT_CATEGORIES);
		expect(existsSync(join(agentDir.path, "settings.json"))).toBe(true);
	});

	it("replaces the default with the project's configured set", () => {
		const config = loadConfig(projectWithCategories({ frontend: "React and CSS", general: "other" }));
		expect(config.categories).toEqual({ frontend: "React and CSS", general: "other" });
		expect(config.categories.formatting).toBeUndefined();
	});

	it("drops entries without a description and falls back to the default map", () => {
		expect(loadConfig(projectWithCategories({ frontend: "React and CSS", empty: "" })).categories).toEqual({
			frontend: "React and CSS",
		});
		expect(loadConfig(projectWithCategories({ empty: "" })).categories).toEqual(DEFAULT_CATEGORIES);
	});
});

describe("modelMap normalization", () => {
	it("accepts a worker stage", () => {
		const config = loadConfig(projectWithTaste({ modelMap: [{ match: "*", stages: ["reflect"], model: "p/m" }] }));
		expect(config.modelMap).toEqual([{ match: "*", stages: ["reflect"], model: "p/m" }]);
	});

	it("rejects an entry whose stages are all non-worker stages", () => {
		const config = loadConfig(
			projectWithTaste({ modelMap: [{ match: "*", stages: ["distill", "prune"], model: "p/m" }] }),
		);
		expect(config.modelMap).toEqual([]);
	});

	it("accepts a substitution-only model that supplies its own provider", () => {
		const config = loadConfig(projectWithTaste({ modelMap: [{ match: "*", model: "$model:low" }] }));
		expect(config.modelMap).toEqual([{ match: "*", model: "$model:low" }]);
	});

	it("rejects a model with no provider and no provider substitution", () => {
		const config = loadConfig(projectWithTaste({ modelMap: [{ match: "*", model: "gpt-5" }] }));
		expect(config.modelMap).toEqual([]);
	});
});

describe("buildDistillQuestions", () => {
	it("offers exactly the provided vocabulary to the classifier", () => {
		const questions = buildDistillQuestions("s1", { frontend: "React and CSS", general: "other" });
		const criteria = questions[questionKey("s1", "category")]?.criteria;
		expect(Object.keys(criteria ?? {})).toEqual(["frontend", "general"]);
	});
});
