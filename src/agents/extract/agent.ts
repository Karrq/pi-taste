import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { normalizeTasteContent, type Signal, type SignalKind } from "../../ledger/index.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import { logAgentStreamError } from "../stream-errors.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { EXTRACT_SYSTEM } from "./prompts.js";

export interface RunExtractionArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	/** Source-addressed conversation chunk. */
	chunk: string;
	/** Ids the model may cite; any signal citing anything else is rejected. */
	allowedSourceEntryIds: string[];
	projectKey: string;
	sessionId?: string;
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

const SignalKindSchema = Type.Union([
	Type.Literal("stated"),
	Type.Literal("correction"),
	Type.Literal("explicit"),
]);

const RecordSignalsSchema = Type.Object({
	signals: Type.Array(
		Type.Object({
			content: Type.String({
				minLength: 1,
				description: "Single-line preference in the user's own words. No markdown, no tags.",
			}),
			kind: SignalKindSchema,
			sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description:
					"Exact source entry ids from the chunk that support this signal. "
					+ "Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
			}),
		}),
		{ description: "Batch of new signals. Omit the tool call entirely when the chunk has none." },
	),
});

type RecordSignalsArgs = Static<typeof RecordSignalsSchema>;

/**
 * Thrown when the agent loop ends with an API/stream failure (`stopReason`
 * `"error"`/`"aborted"`) without recording anything, so the caller can tell a
 * hard failure from a deliberate empty result.
 */
export class ExtractionStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`extraction stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "ExtractionStreamError";
		this.stopReason = stopReason;
	}
}

/**
 * Validate and order cited source ids against the allowlist. Returns undefined
 * when any id is unknown, so a hallucinated citation rejects the whole signal
 * rather than being silently dropped.
 */
export function normalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): string[] | undefined {
	if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedSourceEntryIds.length; i++) allowedOrder.set(allowedSourceEntryIds[i], i);

	const seen = new Set<string>();
	for (const id of sourceEntryIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

export async function runExtraction(args: RunExtractionArgs): Promise<Signal[] | undefined> {
	const conversation = args.chunk.trim();
	if (!conversation) return undefined;

	const now = args.now ?? nowTimestamp;
	const accumulated = new Map<string, Signal>();

	const recordSignals: AgentTool<typeof RecordSignalsSchema> = {
		name: "record_signals",
		label: "Record signals",
		description:
			"Record a batch of durable user preferences found in the conversation chunk. "
			+ "Call it as you work through the chunk; stop when the chunk is covered and reply with a short plain-text confirmation.",
		parameters: RecordSignalsSchema,
		execute: async (_id, params: RecordSignalsArgs) => {
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const candidate of params.signals) {
				const sourceEntryIds = normalizeSourceEntryIds(candidate.sourceEntryIds, args.allowedSourceEntryIds);
				if (!sourceEntryIds) {
					rejected++;
					continue;
				}
				const content = truncateRecordContent(candidate.content);
				const id = hashId(normalizeTasteContent(content));
				if (accumulated.has(id)) {
					duplicates++;
					continue;
				}
				accumulated.set(id, {
					id,
					content,
					timestamp: now(),
					kind: candidate.kind as SignalKind,
					projectKey: args.projectKey,
					sourceEntryIds,
					...(args.sessionId ? { sessionId: args.sessionId } : {}),
				});
				added++;
			}
			const rejectedPart = rejected > 0 ? ` ${rejected} rejected for missing or invalid sourceEntryIds.` : "";
			return {
				content: [{
					type: "text" as const,
					text:
						`Recorded ${added} new signal${added === 1 ? "" : "s"} `
						+ (duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).` : ".")
						+ rejectedPart
						+ ` Total so far this run: ${accumulated.size}. `
						+ "Continue if the chunk still has uncovered preferences; otherwise stop calling the tool.",
				}],
				details: { added, duplicates, rejected, total: accumulated.size },
			};
		},
	};

	const userText = `Current local time: ${now()}

Extract durable user preferences from the new conversation chunk below by calling record_signals one or more times. Cite only source entry ids shown in the chunk. If the chunk contains no durable preference, do not call the tool and reply "no signals".

NEW CONVERSATION CHUNK:
${conversation}`;

	const prompts: Message[] = [
		{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
	];
	const context: AgentContext = {
		messages: [{ role: "system", content: EXTRACT_SYSTEM, timestamp: Date.now() }],
		tools: [recordSignals as AgentTool<any>],
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
		logAgentStreamError("extract", event);
		const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
		if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			streamError = { stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
	}
	await stream.result();

	if (accumulated.size === 0) {
		if (streamError) throw new ExtractionStreamError(streamError.stopReason, streamError.errorMessage);
		return undefined;
	}
	return Array.from(accumulated.values());
}
