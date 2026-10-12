import type { ClassifierAnswer } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { distillSignals } from "../src/agents/distill/index.js";
import type { ClassifierRegistry } from "../src/agents/distill/classifier.js";
import { buildDistillQuestions, collectAnswers, questionKey } from "../src/agents/distill/questions.js";
import { CLASSIFIER_DEFAULTS, DEFAULT_CATEGORIES } from "../src/config.js";
import { normalizeTasteContent, type Signal } from "../src/ledger/index.js";
import { hashId } from "../src/ids.js";

function sig(content: string, kind: Signal["kind"] = "stated"): Signal {
	return {
		id: hashId(normalizeTasteContent(content)),
		content,
		timestamp: "2026-01-01 00:00",
		kind,
		projectKey: "k",
		sourceEntryIds: ["m1"],
	};
}

function answersFor(signalId: string, overrides: Record<string, ClassifierAnswer> = {}): Record<string, ClassifierAnswer> {
	return {
		[questionKey(signalId, "is_preference")]: { type: "bool", probability: 0.9 },
		[questionKey(signalId, "category")]: {
			type: "choice",
			choice: "testing",
			probabilities: { testing: 0.9 },
			confidence: 0.9,
		},
		[questionKey(signalId, "explicit")]: { type: "bool", probability: 0.9 },
		[questionKey(signalId, "confidence")]: { type: "score", score: 2, confidence: 1 },
		[questionKey(signalId, "general")]: { type: "bool", probability: 0.1 },
		...overrides,
	};
}

function fakeRegistry(answers: Record<string, ClassifierAnswer>): ClassifierRegistry {
	return {
		classify: async () =>
			({ api: "typesafe-system-one", provider: "p", model: "c", answers, stopReason: "stop", timestamp: Date.now() }) as never,
		getModelsOfType: () => [{ provider: "p", id: "c" } as never],
		findOfType: () => ({ provider: "p", id: "c" } as never),
	};
}

describe("distill questions", () => {
	it("builds the five typed questions for a signal", () => {
		const questions = buildDistillQuestions("s1", DEFAULT_CATEGORIES);
		expect(Object.keys(questions).sort()).toEqual([
			"s1::category",
			"s1::confidence",
			"s1::explicit",
			"s1::general",
			"s1::is_preference",
		]);
	});

	it("collects complete answers and normalizes the score", () => {
		const signal = sig("Always use tabs");
		const collected = collectAnswers(answersFor(signal.id));
		expect(collected.get(signal.id)?.confidence).toBe(1);
		expect(collected.get(signal.id)?.category).toBe("testing");
	});
});

describe("distillSignals", () => {
	it("uses the heuristic when the mode is off", async () => {
		const signal = sig("Always use tabs");
		const candidates = await distillSignals({
			signals: [signal],
			project: "p",
			categories: DEFAULT_CATEGORIES,
			config: { ...CLASSIFIER_DEFAULTS, mode: "off" },
		});
		expect(candidates[0]?.category).toBe("general");
		expect(candidates[0]?.confidence).toBe(0.7);
	});

	it("uses the classifier verdict in primary mode", async () => {
		const signal = sig("Always add tests");
		const candidates = await distillSignals({
			signals: [signal],
			project: "p",
			categories: DEFAULT_CATEGORIES,
			config: { ...CLASSIFIER_DEFAULTS, mode: "primary" },
			registry: fakeRegistry(answersFor(signal.id)),
		});
		expect(candidates[0]?.category).toBe("testing");
		expect(candidates[0]?.confidence).toBe(1);
	});

	it("keeps the heuristic verdict in shadow mode while the classifier agrees", async () => {
		const signal = sig("Always add tests");
		const candidates = await distillSignals({
			signals: [signal],
			project: "p",
			categories: DEFAULT_CATEGORIES,
			config: { ...CLASSIFIER_DEFAULTS, mode: "shadow" },
			registry: fakeRegistry(answersFor(signal.id)),
		});
		expect(candidates[0]?.category).toBe("general");
	});

	it("falls back to the heuristic when the classifier throws", async () => {
		const signal = sig("Always use tabs");
		const registry: ClassifierRegistry = {
			classify: async () => {
				throw new Error("endpoint down");
			},
			getModelsOfType: () => [{ provider: "p", id: "c" } as never],
			findOfType: () => ({ provider: "p", id: "c" } as never),
		};
		const candidates = await distillSignals({
			signals: [signal],
			project: "p",
			categories: DEFAULT_CATEGORIES,
			config: { ...CLASSIFIER_DEFAULTS, mode: "primary" },
			registry,
		});
		expect(candidates[0]?.category).toBe("general");
	});
});
