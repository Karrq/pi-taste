import type { ClassifierAnswer } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { Classify } from "../src/agents/distill/classifier.js";
import { tasteEntryId, type TasteEntry } from "../src/ledger/index.js";
import { contradictionPairs, pickContradictionLoser, pruneEntries } from "../src/prune.js";

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
		projectKeys: ["--p--"],
		createdAt: at,
		updatedAt: at,
		...overrides,
	};
}

function answers(probability: number): Classify {
	return async (_state, questions) => {
		const out: Record<string, ClassifierAnswer> = {};
		for (const key of Object.keys(questions)) out[key] = { type: "bool", probability };
		return { answers: out };
	};
}

describe("low-confidence pruning", () => {
	it("retracts an inferred entry below the floor but never an explicit one", async () => {
		const inferred = entry("Inferred low", { confidence: 0.2, explicit: false });
		const explicit = entry("Explicit low", { confidence: 0.2, explicit: true });
		const result = await pruneEntries({
			entries: [inferred, explicit],
			confidenceFloor: 0.3,
			maxQuestionsPerRequest: 10,
		});
		expect(result.retractions.map((r) => r.entryId)).toEqual([inferred.id]);
	});
});

describe("contradiction pruning", () => {
	it("retracts the older entry when the classifier reports a contradiction", async () => {
		const older = entry("Always use tabs", { category: "formatting", updatedAt: "2026-01-01T00:00:00.000Z" });
		const newer = entry("Always use spaces", { category: "formatting", updatedAt: "2026-02-01T00:00:00.000Z" });
		const result = await pruneEntries({
			entries: [older, newer],
			confidenceFloor: 0,
			classifier: answers(0.9),
			maxQuestionsPerRequest: 10,
		});
		expect(result.retractions).toHaveLength(1);
		expect(result.retractions[0]?.entryId).toBe(older.id);
		expect(result.classifierPairs).toBe(1);
	});

	it("keeps both entries when the classifier finds no contradiction", async () => {
		const a = entry("Prefer named exports", { category: "typescript" });
		const b = entry("Prefer async await", { category: "typescript" });
		const result = await pruneEntries({
			entries: [a, b],
			confidenceFloor: 0,
			classifier: answers(0.1),
			maxQuestionsPerRequest: 10,
		});
		expect(result.retractions).toHaveLength(0);
	});

	it("retracts a non-explicit entry in favor of an explicit one regardless of age", () => {
		const explicit = entry("Use tabs", { explicit: true, updatedAt: "2026-01-01T00:00:00.000Z" });
		const inferred = entry("Use spaces", { explicit: false, updatedAt: "2026-02-01T00:00:00.000Z" });
		expect(pickContradictionLoser(explicit, inferred).id).toBe(inferred.id);
	});

	it("caps the number of pairs and reports truncation", async () => {
		const entries = [
			entry("a", { category: "x" }),
			entry("b", { category: "x" }),
			entry("c", { category: "x" }),
		];
		const result = await pruneEntries({
			entries,
			confidenceFloor: 0,
			classifier: answers(0.9),
			maxQuestionsPerRequest: 1,
		});
		expect(result.classifierPairs).toBe(1);
		expect(result.classifierTruncated).toBe(true);
	});

	it("keeps deterministic retractions when the classifier fails", async () => {
		const low = entry("Low confidence", { confidence: 0.1, category: "x" });
		const a = entry("A", { category: "x" });
		const b = entry("B", { category: "x" });
		const failing: Classify = async () => {
			throw new Error("endpoint down");
		};
		const result = await pruneEntries({
			entries: [low, a, b],
			confidenceFloor: 0.3,
			classifier: failing,
			maxQuestionsPerRequest: 10,
		});
		expect(result.retractions.map((r) => r.entryId)).toEqual([low.id]);
		expect(result.classifierError).toContain("endpoint down");
	});
});

describe("contradictionPairs", () => {
	it("only pairs entries within the same category", () => {
		const pairs = contradictionPairs(
			[entry("a", { category: "x" }), entry("b", { category: "y" }), entry("c", { category: "x" })],
			10,
		);
		expect(pairs.pairs).toHaveLength(1);
	});
});
