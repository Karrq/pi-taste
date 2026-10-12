import { describe, expect, it } from "vitest";
import { DEFAULTS, type Config, type ModelMapEntry } from "../src/config.js";
import { resolveTasteModel } from "../src/model-resolver.js";
import { Runtime } from "../src/runtime.js";

const SESSION = { provider: "claude-bridge", id: "opus" };

const MODELS: Record<string, unknown> = {
	"claude-bridge/opus": SESSION,
	"claude-bridge/cheap": { provider: "claude-bridge", id: "cheap" },
	"claude-bridge/smart": { provider: "claude-bridge", id: "smart" },
};

function registry(overrides: { auth?: () => unknown } = {}) {
	return {
		find: (provider: string, id: string) => MODELS[`${provider}/${id}`],
		getApiKeyAndHeaders: async () => overrides.auth?.() ?? { ok: true, apiKey: "k" },
	};
}

function runtimeWith(modelMap: ModelMapEntry[]): Runtime {
	const runtime = new Runtime();
	runtime.config = { ...DEFAULTS, modelMap } satisfies Config;
	runtime.configLoaded = true;
	return runtime;
}

describe("resolveTasteModel", () => {
	it("uses the session model when no map entry matches", async () => {
		const resolved = await resolveTasteModel(runtimeWith([]), {
			model: SESSION,
			modelRegistry: registry(),
			stage: "extract",
		});
		expect(resolved?.model).toMatchObject(SESSION);
	});

	it("routes per stage by glob", async () => {
		const runtime = runtimeWith([
			{ match: "claude-bridge/*", stages: ["extract"], model: "claude-bridge/cheap" },
			{ match: "claude-bridge/*", stages: ["reflect"], model: "claude-bridge/smart" },
		]);
		const extract = await resolveTasteModel(runtime, {
			model: SESSION,
			modelRegistry: registry(),
			stage: "extract",
		});
		const reflect = await resolveTasteModel(runtime, {
			model: SESSION,
			modelRegistry: registry(),
			stage: "reflect",
		});
		expect(extract?.model).toMatchObject({ provider: "claude-bridge", id: "cheap" });
		expect(reflect?.model).toMatchObject({ provider: "claude-bridge", id: "smart" });
	});

	it("keeps claude-bridge work on claude-bridge models via substitution", async () => {
		const runtime = runtimeWith([{ match: "claude-bridge/*", model: "$provider/$id:high" }]);
		const resolved = await resolveTasteModel(runtime, {
			model: SESSION,
			modelRegistry: registry(),
			stage: "extract",
		});
		expect(resolved?.model).toMatchObject({ provider: "claude-bridge", id: "opus" });
		expect(resolved?.thinking).toBe("high");
	});

	it("keeps the session model with an adjusted thinking via $model", async () => {
		const runtime = runtimeWith([{ match: "*", stages: ["extract"], model: "$model:low" }]);
		const resolved = await resolveTasteModel(runtime, {
			model: SESSION,
			modelRegistry: registry(),
			stage: "extract",
		});
		expect(resolved?.model).toMatchObject(SESSION);
		expect(resolved?.thinking).toBe("low");
	});

	it("lets a session override win over the modelMap", async () => {
		const runtime = runtimeWith([{ match: "claude-bridge/*", model: "claude-bridge/cheap" }]);
		runtime.modelOverride = { provider: "claude-bridge", id: "smart" };
		const resolved = await resolveTasteModel(runtime, {
			model: SESSION,
			modelRegistry: registry(),
			stage: "extract",
		});
		expect(resolved?.model).toMatchObject({ provider: "claude-bridge", id: "smart" });
	});

	it("falls back to the session model when the override is cleared", async () => {
		const runtime = runtimeWith([]);
		runtime.modelOverride = { provider: "claude-bridge", id: "smart" };
		runtime.modelOverride = undefined;
		const resolved = await resolveTasteModel(runtime, {
			model: SESSION,
			modelRegistry: registry(),
			stage: "extract",
		});
		expect(resolved?.model).toMatchObject(SESSION);
	});

	it("returns undefined when the resolved model has no usable auth", async () => {
		const runtime = runtimeWith([]);
		const resolved = await resolveTasteModel(runtime, {
			model: SESSION,
			modelRegistry: registry({ auth: () => ({ ok: true }) }),
			stage: "extract",
		});
		expect(resolved).toBeUndefined();
	});
});
