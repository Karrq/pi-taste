import type { ClassifierQuestion, JsonObject } from "@earendil-works/pi-ai";
import type { ClassifierRegistry, Classify } from "./agents/distill/classifier.js";
import { resolveClassifier } from "./agents/distill/classifier.js";
import { appendLedger, foldLedger, readLedger } from "./ledger/index.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "./ledger/paths.js";
import type { LedgerRecord, TasteEntry, TasteScope } from "./ledger/index.js";
import type { Runtime } from "./runtime.js";

/** A bool answer at or above this counts as a genuine contradiction. */
export const CONTRADICTION_THRESHOLD = 0.5;

export interface PruneRetraction {
	entryId: string;
	reason: string;
}

export interface PruneResult {
	retractions: PruneRetraction[];
	/** Pairs actually sent to the classifier. */
	classifierPairs: number;
	/** True when more pairs existed than the question budget allowed. */
	classifierTruncated: boolean;
	/** Set when the classifier was configured but failed; the run still pruned deterministically. */
	classifierError?: string;
}

export interface PruneOptions {
	entries: readonly TasteEntry[];
	confidenceFloor: number;
	classifier?: Classify;
	maxQuestionsPerRequest: number;
}

/**
 * A low-confidence, inferred entry is pruned. Explicit entries are never pruned
 * on confidence: the user stated them, so dropping them silently would be worse
 * than keeping a noisy line.
 */
export function lowConfidenceRetractions(entries: readonly TasteEntry[], floor: number): PruneRetraction[] {
	return entries
		.filter((entry) => !entry.explicit && entry.confidence < floor)
		.map((entry) => ({
			entryId: entry.id,
			reason: `confidence ${entry.confidence.toFixed(2)} below prune floor ${floor}`,
		}));
}

export function contradictionKey(a: TasteEntry, b: TasteEntry): string {
	const [x, y] = [a.id, b.id].sort();
	return `${x}::${y}::contradicts`;
}

export function contradictionQuestion(a: TasteEntry, b: TasteEntry): ClassifierQuestion {
	return {
		type: "bool",
		instructions: [
			`Two preferences were learned in the same category (${a.category}):`,
			`A: ${a.content}`,
			`B: ${b.content}`,
			"Can both be followed at the same time, or does following one necessarily violate the other?",
		].join("\n"),
		criteria: {
			true: "Following A and following B cannot both hold; they contradict.",
			false: "They are compatible, complementary, or about different concerns.",
		},
	};
}

/**
 * Pairs are only formed within a category, which is what a contradiction can
 * meaningfully share, and are ordered newest-first so a bounded budget spends on
 * the most recently changed preferences.
 */
export function contradictionPairs(
	entries: readonly TasteEntry[],
	maxPairs: number,
): { pairs: Array<[TasteEntry, TasteEntry]>; truncated: boolean } {
	const byCategory = new Map<string, TasteEntry[]>();
	for (const entry of entries) {
		const group = byCategory.get(entry.category);
		if (group) group.push(entry);
		else byCategory.set(entry.category, [entry]);
	}

	const pairs: Array<[TasteEntry, TasteEntry]> = [];
	for (const group of byCategory.values()) {
		const sorted = [...group].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		for (let i = 0; i < sorted.length; i++) {
			for (let j = i + 1; j < sorted.length; j++) pairs.push([sorted[i] as TasteEntry, sorted[j] as TasteEntry]);
		}
	}
	if (pairs.length <= maxPairs) return { pairs, truncated: false };
	return { pairs: pairs.slice(0, maxPairs), truncated: true };
}

/** An explicitly stated preference wins over an inferred one; otherwise the newer one wins. */
export function pickContradictionLoser(a: TasteEntry, b: TasteEntry): TasteEntry {
	if (a.explicit !== b.explicit) return a.explicit ? b : a;
	const byTime = b.updatedAt.localeCompare(a.updatedAt);
	if (byTime !== 0) return byTime > 0 ? a : b;
	return a.confidence <= b.confidence ? a : b;
}

/**
 * Retract entries that are no longer worth keeping. The deterministic half runs
 * always; the classifier half adds contradiction detection and degrades to
 * deterministic-only when the endpoint fails, so a prune run never loses what it
 * already found.
 */
export async function pruneEntries(options: PruneOptions): Promise<PruneResult> {
	const retractions = lowConfidenceRetractions(options.entries, options.confidenceFloor);
	const retracted = new Set(retractions.map((retraction) => retraction.entryId));
	let classifierPairs = 0;
	let classifierTruncated = false;
	let classifierError: string | undefined;

	if (options.classifier) {
		const survivors = options.entries.filter((entry) => !retracted.has(entry.id));
		const budget = Math.max(1, Math.floor(options.maxQuestionsPerRequest));
		const { pairs, truncated } = contradictionPairs(survivors, budget);
		classifierPairs = pairs.length;
		classifierTruncated = truncated;

		if (pairs.length > 0) {
			try {
				const state = {
					entries: survivors.map((entry) => ({
						id: entry.id,
						category: entry.category,
						content: entry.content,
						explicit: entry.explicit,
						updatedAt: entry.updatedAt,
					})),
				} as unknown as JsonObject;
				const questions: Record<string, ClassifierQuestion> = {};
				for (const [a, b] of pairs) questions[contradictionKey(a, b)] = contradictionQuestion(a, b);

				const { answers } = await options.classifier(state, questions);
				for (const [a, b] of pairs) {
					const answer = answers[contradictionKey(a, b)];
					if (answer?.type !== "bool" || answer.probability < CONTRADICTION_THRESHOLD) continue;
					const loser = pickContradictionLoser(a, b);
					const winner = loser.id === a.id ? b : a;
					if (retracted.has(loser.id)) continue;
					retractions.push({ entryId: loser.id, reason: `contradicted by ${winner.id}` });
					retracted.add(loser.id);
				}
			} catch (error) {
				classifierError = error instanceof Error ? error.message : String(error);
			}
		}
	}

	return {
		retractions,
		classifierPairs,
		classifierTruncated,
		...(classifierError ? { classifierError } : {}),
	};
}

export function retractionRecords(retractions: readonly PruneRetraction[], at: string): LedgerRecord[] {
	return retractions.map((retraction) => ({
		type: "entry.retracted",
		at,
		entryId: retraction.entryId,
		reason: retraction.reason,
	}));
}

export interface PruneRunResult extends PruneResult {
	total: number;
}

/** Prune one ledger's active entries and append the tombstones. */
export async function runTastePrune(
	runtime: Runtime,
	args: { cwd: string; modelRegistry?: unknown; now?: string },
): Promise<PruneRunResult> {
	runtime.ensureConfig(args.cwd);
	const scope = args.scope ?? "project";
	const path = ledgerPath(scope === "global" ? globalTasteDir() : projectTasteDir(args.cwd));
	const active = foldLedger(readLedger(path)).activeEntries;

	let classifier: Classify | undefined;
	if (runtime.config.classifier.mode !== "off") {
		try {
			classifier = resolveClassifier(
				args.modelRegistry as ClassifierRegistry | undefined,
				{ provider: runtime.config.classifier.provider, model: runtime.config.classifier.model },
				runtime.config.classifier.requestTimeoutMs,
			);
		} catch {
			// A malformed registry means no decision model; deterministic pruning stands.
			classifier = undefined;
		}
	}

	const result = await pruneEntries({
		entries: active,
		confidenceFloor: runtime.config.pruneConfidenceFloor,
		...(classifier ? { classifier } : {}),
		maxQuestionsPerRequest: runtime.config.classifier.maxQuestionsPerRequest,
	});
	if (result.retractions.length > 0) {
		appendLedger(path, retractionRecords(result.retractions, args.now ?? new Date().toISOString()));
	}
	return { ...result, total: active.length };
}
