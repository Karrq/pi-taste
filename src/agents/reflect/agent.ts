import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import type { TasteEntry } from "../../ledger/index.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { nowTimestamp } from "../../serialize.js";
import { TASTE_CATEGORIES } from "../distill/questions.js";
import { logAgentStreamError } from "../stream-errors.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { REFLECT_SYSTEM } from "./prompts.js";

/** A raw consolidation proposal: which entries to merge and the statement that replaces them. */
export interface MergeProposal {
	fromIds: string[];
	content: string;
	category: string;
}

export interface RunReflectionArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	/** The active entries the model may cite; anything else is rejected. */
	entries: readonly TasteEntry[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
	usage?: { addEvent(event: unknown): void };
	/** Injectable clock, for tests. */
	now?: () => string;
}

const ProposeMergesSchema = Type.Object({
	merges: Type.Array(
		Type.Object({
			fromIds: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 2,
				description:
					"Ids of the active entries being consolidated, exactly as shown in the prompt. "
					+ "Never invent ids, and never reuse an entry across groups.",
			}),
			content: Type.String({
				minLength: 1,
				description:
					"One imperative single-line statement that preserves every distinct fact from the merged entries. No markdown, no tags.",
			}),
			category: Type.String({
				minLength: 1,
				description: "The single best category for the consolidated statement.",
			}),
		}),
		{ description: "Batch of consolidation proposals. Omit the tool call entirely when nothing should merge." },
	),
});

type ProposeMergesArgs = Static<typeof ProposeMergesSchema>;

/** Thrown when the loop ends on a stream failure without producing anything. */
export class ReflectionStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`reflection stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "ReflectionStreamError";
		this.stopReason = stopReason;
	}
}

/**
 * Ask the model to consolidate the active entries. Validation of the proposals
 * lives in the reflect stage, which is why this only rejects citations of
 * unknown ids and duplicate groups here; the model gets the feedback it needs to
 * self-correct within the run.
 */
export async function runReflection(args: RunReflectionArgs): Promise<MergeProposal[] | undefined> {
	if (args.entries.length < 2) return undefined;

	const now = args.now ?? nowTimestamp;
	const allowedIds = new Set(args.entries.map((entry) => entry.id));
	const accumulated = new Map<string, MergeProposal>();

	const proposeMerges: AgentTool<typeof ProposeMergesSchema> = {
		name: "propose_merges",
		label: "Propose merges",
		description:
			"Propose groups of existing taste entries that should be consolidated into one statement. "
			+ "Call it as you work; stop when the entries are covered and reply with a short plain-text confirmation.",
		parameters: ProposeMergesSchema,
		execute: async (_id, params: ProposeMergesArgs) => {
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const candidate of params.merges) {
				const fromIds = [...new Set(candidate.fromIds)];
				if (fromIds.length < 2 || fromIds.some((id) => !allowedIds.has(id))) {
					rejected++;
					continue;
				}
				const key = [...fromIds].sort().join("|");
				if (accumulated.has(key)) {
					duplicates++;
					continue;
				}
				accumulated.set(key, { fromIds, content: candidate.content, category: candidate.category });
				added++;
			}
			const rejectedPart = rejected > 0 ? ` ${rejected} rejected for missing or invalid entry ids.` : "";
			return {
				content: [{
					type: "text" as const,
					text:
						`Recorded ${added} merge proposal${added === 1 ? "" : "s"} `
						+ (duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).` : ".")
						+ rejectedPart
						+ ` Total so far this run: ${accumulated.size}. `
						+ "Continue if more groups remain; otherwise stop calling the tool.",
				}],
				details: { added, duplicates, rejected, total: accumulated.size },
			};
		},
	};

	const entryList = args.entries.map((entry) => `[${entry.id}] (${entry.category}) ${entry.content}`).join("\n");
	const userText = `Current local time: ${now()}

Consolidate the active taste entries below by calling propose_merges. Cite entry ids exactly as shown. Categories: ${Object.keys(TASTE_CATEGORIES).join(", ")}.

ACTIVE ENTRIES:
${entryList}`;

	const prompts: Message[] = [
		{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
	];
	const context: AgentContext = {
		messages: [{ role: "system", content: REFLECT_SYSTEM, timestamp: Date.now() }],
		tools: [proposeMerges as AgentTool<any>],
	};

	const reasoning = (args.model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model: args.model,
		apiKey: args.apiKey,
		headers: args.headers,
		env: args.env,
		maxTokens: boundedMaxTokens(args.model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (messages) => messages as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
				finishTurn: (turn) => {
					if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
					turnCount++;
					return turnCount >= effectiveMaxTurns ? { action: "end" } : undefined;
				},
			}
			: {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(
		prompts,
		context,
		config,
		args.signal,
		resolveWorkerStreamSimple(args.model, args.modelRegistry, args.streamSimple),
	);
	let streamError: { stopReason: string; errorMessage?: string } | undefined;
	for await (const event of stream) {
		args.usage?.addEvent(event);
		logAgentStreamError("reflect", event);
		const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
		if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			streamError = { stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
	}
	await stream.result();

	if (accumulated.size === 0) {
		if (streamError) throw new ReflectionStreamError(streamError.stopReason, streamError.errorMessage);
		return undefined;
	}
	return Array.from(accumulated.values());
}
