import type { ClassifierAnswer, ClassifierQuestion, JsonObject } from "@earendil-works/pi-ai";
import type { Signal } from "../../ledger/index.js";

export const SIGNAL_KEYS = ["is_preference", "category", "explicit", "confidence", "general"] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

const CONFIDENCE_LEVELS = [
	"Weak: mentioned once, ambiguously, or in passing.",
	"Moderate: clearly stated once.",
	"Strong: stated clearly and emphasized, or repeated.",
];

export function questionKey(signalId: string, key: SignalKey): string {
	return `${signalId}::${key}`;
}

export function parseQuestionKey(key: string): { signalId: string; signalKey: SignalKey } | undefined {
	const separator = key.lastIndexOf("::");
	if (separator <= 0) return undefined;
	const signalKey = key.slice(separator + 2) as SignalKey;
	if (!SIGNAL_KEYS.includes(signalKey)) return undefined;
	return { signalId: key.slice(0, separator), signalKey };
}

export interface DistillStateInput {
	project: string;
	signals: readonly Signal[];
}

/**
 * State is sent once per request and referenced by question instructions, so a
 * batch of signals costs one state payload rather than one per question.
 */
export function buildDistillState(input: DistillStateInput): JsonObject {
	return {
		project: input.project,
		signals: input.signals.map((signal) => ({
			id: signal.id,
			kind: signal.kind,
			content: signal.content,
		})),
	} as unknown as JsonObject;
}

function about(signalId: string, question: string): string {
	return `Consider the entry in \`signals\` whose id is \`${signalId}\`. ${question}`;
}

export function buildDistillQuestions(
	signalId: string,
	categories: Record<string, string>,
): Record<string, ClassifierQuestion> {
	return {
		[questionKey(signalId, "is_preference")]: {
			type: "bool",
			instructions: about(
				signalId,
				"Is this a durable, generalizable preference about how code or work should be done, rather than a one-off task detail that will not matter in a later session?",
			),
			criteria: {
				true: "It states or corrects how something should be done, in a way that outlives this task.",
				false: "It is a request about this specific task, file, or bug and carries no lasting preference.",
			},
		},
		[questionKey(signalId, "category")]: {
			type: "choice",
			instructions: about(signalId, "Which single category best fits the preference?"),
			criteria: categories,
		},
		[questionKey(signalId, "explicit")]: {
			type: "bool",
			instructions: about(signalId, "Did the user state this preference directly, rather than it being only implied?"),
			criteria: {
				true: "The user said or corrected it themselves.",
				false: "It is inferred from context rather than stated.",
			},
		},
		[questionKey(signalId, "confidence")]: {
			type: "score",
			instructions: about(signalId, "How strongly does the conversation support this preference as the user's actual taste?"),
			criteria: CONFIDENCE_LEVELS,
		},
		[questionKey(signalId, "general")]: {
			type: "bool",
			instructions: about(
				signalId,
				"Is this a general working style likely to apply across projects, rather than specific to this project's stack or constraints?",
			),
			criteria: {
				true: "It is about how the user works, independent of this codebase.",
				false: "It depends on this project's stack, conventions, or constraints.",
			},
		},
	};
}

export interface SignalAnswers {
	is_preference?: number;
	category?: string;
	explicit?: number;
	confidence?: number;
	general?: number;
}

function answerNumber(answer: ClassifierAnswer | undefined, levels: number): number | undefined {
	if (!answer) return undefined;
	if (answer.type === "bool") return Number.isFinite(answer.probability) ? answer.probability : undefined;
	if (answer.type === "score" && Number.isFinite(answer.score)) {
		return answer.score / Math.max(1, levels - 1);
	}
	return undefined;
}

/** Collect answers into per-signal values. A signal missing any answer is omitted, never guessed. */
export function collectAnswers(answers: Record<string, ClassifierAnswer>): Map<string, SignalAnswers> {
	const partial = new Map<string, SignalAnswers>();
	for (const [key, answer] of Object.entries(answers)) {
		const parsed = parseQuestionKey(key);
		if (!parsed) continue;
		const current = partial.get(parsed.signalId) ?? {};
		if (parsed.signalKey === "category") {
			if (answer.type === "choice" && typeof answer.choice === "string") current.category = answer.choice;
		} else if (parsed.signalKey === "confidence") {
			const value = answerNumber(answer, CONFIDENCE_LEVELS.length);
			if (value !== undefined) current.confidence = Math.min(1, Math.max(0, value));
		} else {
			const value = answerNumber(answer, 2);
			if (value !== undefined) current[parsed.signalKey] = Math.min(1, Math.max(0, value));
		}
		partial.set(parsed.signalId, current);
	}

	const complete = new Map<string, SignalAnswers>();
	for (const [signalId, value] of partial) {
		if (value.is_preference !== undefined && value.category !== undefined && value.confidence !== undefined) {
			complete.set(signalId, value);
		}
	}
	return complete;
}
