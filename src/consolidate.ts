import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { basename } from "node:path";
import { runExtraction } from "./agents/extract/agent.js";
import { distillSignals } from "./agents/distill/index.js";
import type { ClassifierRegistry } from "./agents/distill/classifier.js";
import { encodeCwd } from "./ledger/paths.js";
import { appendLedger } from "./ledger/store.js";
import type { LedgerRecord } from "./ledger/types.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "./ledger/paths.js";
import { resolveTasteModel } from "./model-resolver.js";
import { runTastePrune } from "./prune.js";
import { reconcileCandidate } from "./reconcile.js";
import { serializeSourceAddressedBranchEntries } from "./serialize.js";
import {
	TASTE_COVERAGE,
	entryIndexById,
	latestCoverageIndex,
	sourceEntriesAfter,
	type TasteCoverageData,
} from "./session/coverage.js";
import type { SessionEntry } from "./session/types.js";
import type { Runtime } from "./runtime.js";

export interface ConsolidationCtx {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	model?: unknown;
	modelRegistry: unknown;
	thinkingLevel?: ModelThinkingLevel;
	sessionManager: {
		getBranch(): unknown[];
		getSessionId?(): string | undefined;
		getSessionFile?(): string | undefined;
	};
	/** Optional progress sink for a UI. Fired before each chunk and before the prune pass. */
	onProgress?: (event: ConsolidationProgress) => void;
	/** Groups this run's ledger writes so `/taste undo` can remove them together. */
	opId?: string;
	/** Abort the run between chunks and cancel any in-flight extraction call. */
	signal?: AbortSignal;
}

/** A coarse progress update: which stage runs next and the counts so far. */
export interface ConsolidationProgress {
	stage: "extract" | "prune";
	/** 1-based chunk about to run, capped at `maxChunks`. */
	chunk: number;
	maxChunks: number;
	signals: number;
	entries: number;
}

export interface ConsolidationDeps {
	runExtraction?: typeof runExtraction;
	resolveModel?: typeof resolveTasteModel;
}

export interface ConsolidationSummary {
	chunks: number;
	signalsRecorded: number;
	entriesUpserted: number;
	entriesRetracted: number;
	/** True when the branch was drained; false when the chunk cap was reached. */
	reachedEnd: boolean;
	/** True when the caller aborted the run. The in-flight chunk is not committed. */
	cancelled: boolean;
}

function sessionIdOf(ctx: ConsolidationCtx): string | undefined {
	try {
		return ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.();
	} catch {
		return undefined;
	}
}

/**
 * Retrospective extraction over the branch, draining source entries the ledger
 * has not covered yet, one source-addressed chunk at a time.
 *
 * Coverage advances even when a chunk yields no signals: the run was an explicit
 * user request that already paid to read that span, so re-paying on the next run
 * would be waste. The chunk cap bounds one run; a caller that hits it can run
 * again to continue.
 */
export async function runTasteConsolidation(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	deps: ConsolidationDeps = {},
): Promise<ConsolidationSummary> {
	runtime.ensureConfig(ctx.cwd);
	const extract = deps.runExtraction ?? runExtraction;
	const resolveModel = deps.resolveModel ?? resolveTasteModel;

	const projectKey = encodeCwd(ctx.cwd);
	const path = ledgerPath(projectTasteDir(ctx.cwd));
	const sessionId = sessionIdOf(ctx);
	const entries = ctx.sessionManager.getBranch() as SessionEntry[];
	const indexById = entryIndexById(entries);

	let cursor = latestCoverageIndex(entries);
	let chunks = 0;
	let signalsRecorded = 0;
	let entriesUpserted = 0;
	let reachedEnd = false;
	let cancelled = false;
	let resolved: Awaited<ReturnType<typeof resolveTasteModel>> | undefined;
	let resolvedOnce = false;

	for (let i = 0; i < runtime.config.consolidateMaxChunks; i++) {
		if (ctx.signal?.aborted) {
			cancelled = true;
			break;
		}
		const backlog = sourceEntriesAfter(entries, cursor);
		if (backlog.length === 0) {
			reachedEnd = true;
			break;
		}

		ctx.onProgress?.({
			stage: "extract",
			chunk: i + 1,
			maxChunks: runtime.config.consolidateMaxChunks,
			signals: signalsRecorded,
			entries: entriesUpserted,
		});

		const { text: chunk, sourceEntryIds, truncatedSourceEntryIds } = serializeSourceAddressedBranchEntries(backlog, {
			maxTokens: runtime.config.extractChunkMaxTokens,
		});
		const coversUpToId = sourceEntryIds.at(-1);
		if (!chunk.trim() || !coversUpToId) {
			reachedEnd = true;
			break;
		}
		void truncatedSourceEntryIds;

		if (!resolvedOnce) {
			resolved = await resolveModel(runtime, {
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				stage: "extract",
				thinkingLevel: ctx.thinkingLevel,
			});
			resolvedOnce = true;
		}
		if (!resolved) throw new Error("no model available for taste extraction");

		let signals: Awaited<ReturnType<typeof extract>>;
		try {
			signals = await extract({
				model: resolved.model,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				env: resolved.env,
				chunk,
				allowedSourceEntryIds: sourceEntryIds,
				projectKey,
				sessionId,
				maxTurns: runtime.config.agentMaxTurns,
				maxOutputTokens: runtime.config.agentMaxTokens,
				thinkingLevel: resolved.thinking,
				modelRegistry: ctx.modelRegistry as never,
				...(ctx.signal ? { signal: ctx.signal } : {}),
			});
		} catch (error) {
			if (ctx.signal?.aborted) {
				cancelled = true;
				break;
			}
			throw error;
		}
		// A cancellation that lands after extraction returns drops this chunk's
		// signals and leaves coverage untouched, so the next run re-reads it whole.
		if (ctx.signal?.aborted) {
			cancelled = true;
			break;
		}

		if (signals && signals.length > 0) {
			const records: LedgerRecord[] = signals.map((signal) => ({
				type: "signal.recorded",
				at: new Date().toISOString(),
				signal,
				...(ctx.opId ? { opId: ctx.opId } : {}),
			}));
			appendLedger(path, records);
			signalsRecorded += signals.length;

			// Distill never throws for an unreachable classifier: it degrades to the
			// heuristic. A hard failure here therefore means a code defect, which is
			// worth recording and surfacing without losing the recorded signals.
			try {
				const candidates = await distillSignals({
					signals,
					project: basename(ctx.cwd),
					config: runtime.config.classifier,
					registry: ctx.modelRegistry as ClassifierRegistry | undefined,
					sessionId,
					categories: runtime.config.categories,
					...(ctx.signal ? { signal: ctx.signal } : {}),
				});
				const now = new Date().toISOString();
				for (const candidate of candidates) {
					const { projectRecords, globalRecords } = reconcileCandidate({
						cwd: ctx.cwd,
						candidate,
						projectKey,
						promoteAtProjectCount: runtime.config.promoteAtProjectCount,
						now,
						...(ctx.opId ? { opId: ctx.opId } : {}),
					});
					appendLedger(path, projectRecords);
					if (globalRecords.length > 0) appendLedger(ledgerPath(globalTasteDir()), globalRecords);
					entriesUpserted += 1;
				}
			} catch (error) {
				runtime.recordStageError("distill", error);
			}
		}

		const data: TasteCoverageData = {
			coversUpToId,
			signalCount: signals?.length ?? 0,
			...(ctx.opId ? { opId: ctx.opId } : {}),
		};
		pi.appendEntry(TASTE_COVERAGE, data);

		const next = indexById.get(coversUpToId);
		if (next === undefined) {
			reachedEnd = true;
			break;
		}
		cursor = next;
		chunks++;
	}

	// Prune runs once over the whole active pool after extraction, not per chunk:
	// contradiction detection needs the complete profile to compare against.
	let entriesRetracted = 0;
	if (!cancelled) {
		ctx.onProgress?.({ stage: "prune", chunk: chunks, maxChunks: runtime.config.consolidateMaxChunks, signals: signalsRecorded, entries: entriesUpserted });
		try {
			const pruned = await runTastePrune(runtime, {
				cwd: ctx.cwd,
				modelRegistry: ctx.modelRegistry,
				...(ctx.opId ? { opId: ctx.opId } : {}),
			});
			entriesRetracted = pruned.retractions.length;
		} catch (error) {
			runtime.recordStageError("prune", error);
		}
	}

	return { chunks, signalsRecorded, entriesUpserted, entriesRetracted, reachedEnd, cancelled };
}
