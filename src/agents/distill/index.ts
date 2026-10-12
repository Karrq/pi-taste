import type { JsonObject } from "@earendil-works/pi-ai";
import type { ClassifierConfig, SystemOneMode } from "../../config.js";
import type { Signal } from "../../ledger/index.js";
import { resolveClassifier, type ClassifierRegistry } from "./classifier.js";
import { buildDistillQuestions, buildDistillState, collectAnswers, type SignalAnswers } from "./questions.js";
import { SIGNAL_KEYS } from "./questions.js";
import { appendDistillScores, type DistillDecisionRow, type DistillScoreRow } from "./scores.js";

export interface DistillDecision extends DistillDecisionRow {
	source: "classifier" | "heuristic";
}

export interface DistilledCandidate {
	content: string;
	category: string;
	confidence: number;
	explicit: boolean;
	general: boolean;
	signal: Signal;
}

export interface DistillOptions {
	signals: readonly Signal[];
	project: string;
	config: ClassifierConfig;
	registry?: ClassifierRegistry;
	sessionId?: string;
	signal?: AbortSignal;
	/** Category choices for the classifier; the configured vocabulary. */
	categories: Record<string, string>;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * The fallback decision when no classifier is registered or the mode is `off`.
 * Every extracted signal is a user expression, so it counts as a preference; the
 * kind sets how much weight it carries.
 */
export function heuristicDecision(signal: Signal): DistillDecision {
	const confidence = signal.kind === "explicit" ? 0.95 : signal.kind === "stated" ? 0.7 : 0.65;
	return {
		isPreference: true,
		category: "general",
		confidence,
		explicit: true,
		general: false,
		source: "heuristic",
	};
}

function decisionFromAnswers(answers: SignalAnswers, preferenceThreshold: number): DistillDecision | undefined {
	if (answers.is_preference === undefined || answers.is_preference < preferenceThreshold) return undefined;
	return {
		isPreference: true,
		category: answers.category ?? "general",
		confidence: clamp01(answers.confidence ?? 0.5),
		explicit: (answers.explicit ?? 0) >= 0.5,
		general: (answers.general ?? 0) >= 0.5,
		source: "classifier",
	};
}

function chunked<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/**
 * Score every signal with the classifier, without deciding. Chunks keep the
 * per-request question count within budget; each chunk references the same
 * state, so category and confidence stay comparable across chunks.
 */
export async function classifySignals(args: {
	classifier: ReturnType<typeof resolveClassifier>;
	state: JsonObject;
	signals: readonly Signal[];
	config: ClassifierConfig;
	categories: Record<string, string>;
}): Promise<Map<string, DistillDecision>> {
	const { classifier, state, signals, config, categories } = args;
	const decisions = new Map<string, DistillDecision>();
	if (!classifier || signals.length === 0) return decisions;

	const perChunk = Math.max(1, Math.floor(config.maxQuestionsPerRequest / SIGNAL_KEYS.length));
	for (const chunk of chunked(signals, perChunk)) {
		const questions: Record<string, ReturnType<typeof buildDistillQuestions>[string]> = {};
		for (const signal of chunk) Object.assign(questions, buildDistillQuestions(signal.id, categories));
		const { answers } = await classifier(state, questions);
		for (const [signalId, values] of collectAnswers(answers)) {
			const decision = decisionFromAnswers(values, config.preferenceThreshold);
			if (decision) decisions.set(signalId, decision);
		}
	}
	return decisions;
}

/**
 * Turn signals into taste candidates. `primary` takes the classifier verdict,
 * `shadow` scores but keeps the heuristic, `off` never calls the classifier.
 * A classifier failure degrades to the heuristic rather than failing the run.
 */
export async function distillSignals(options: DistillOptions): Promise<DistilledCandidate[]> {
	const { signals, config } = options;
	if (signals.length === 0) return [];

	const heuristic = new Map<string, DistillDecision>();
	for (const signal of signals) heuristic.set(signal.id, heuristicDecision(signal));

	let classifierDecisions = new Map<string, DistillDecision>();
	let classifierUsed = false;
	if (config.mode !== "off") {
		try {
			const classifier = resolveClassifier(options.registry, {
				provider: config.provider,
				model: config.model,
			}, config.requestTimeoutMs);
			if (classifier) {
				classifierDecisions = await classifySignals({
					classifier,
					state: buildDistillState({ project: options.project, signals }),
					signals,
					config,
					categories: options.categories,
				});
				classifierUsed = true;
			}
		} catch {
			classifierUsed = false;
		}
	}

	const chosen = config.mode === "primary" && classifierUsed ? classifierDecisions : heuristic;
	const candidates: DistilledCandidate[] = [];
	const rows: DistillScoreRow[] = [];
	const ts = new Date().toISOString();

	for (const signal of signals) {
		const heuristicDecisionForKey = heuristic.get(signal.id);
		if (!heuristicDecisionForKey) continue;
		const decision = chosen.get(signal.id) ?? heuristicDecisionForKey;
		candidates.push({
			content: signal.content,
			category: decision.category,
			confidence: decision.confidence,
			explicit: decision.explicit,
			general: decision.general,
			signal,
		});
		if (classifierUsed) {
			const classifierDecision = classifierDecisions.get(signal.id);
			rows.push({
				ts,
				...(options.sessionId ? { sessionId: options.sessionId } : {}),
				signalId: signal.id,
				mode: config.mode,
				...(classifierDecision ? { classifier: toRow(classifierDecision) } : {}),
				heuristic: toRow(heuristicDecisionForKey),
				applied: decision.source,
			});
		}
	}

	appendDistillScores(options.sessionId, rows);
	return candidates;
}

function toRow(decision: DistillDecision): DistillDecisionRow {
	return {
		isPreference: decision.isPreference,
		category: decision.category,
		confidence: decision.confidence,
		explicit: decision.explicit,
		general: decision.general,
	};
}

export type { ClassifierConfig, SystemOneMode };
