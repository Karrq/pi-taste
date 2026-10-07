import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { runExtraction } from "./agents/extract/agent.js";
import { encodeCwd } from "./ledger/paths.js";
import { appendLedger } from "./ledger/store.js";
import type { LedgerRecord } from "./ledger/types.js";
import { ledgerPath, projectTasteDir } from "./ledger/paths.js";
import { resolveTasteModel } from "./model-resolver.js";
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
}

export interface ConsolidationDeps {
	runExtraction?: typeof runExtraction;
	resolveModel?: typeof resolveTasteModel;
}

export interface ConsolidationSummary {
	chunks: number;
	signalsRecorded: number;
	/** True when the branch was drained; false when the chunk cap was reached. */
	reachedEnd: boolean;
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
	let reachedEnd = false;
	let resolved: Awaited<ReturnType<typeof resolveTasteModel>> | undefined;
	let resolvedOnce = false;

	for (let i = 0; i < runtime.config.consolidateMaxChunks; i++) {
		const backlog = sourceEntriesAfter(entries, cursor);
		if (backlog.length === 0) {
			reachedEnd = true;
			break;
		}

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

		const signals = await extract({
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
		});

		if (signals && signals.length > 0) {
			const records: LedgerRecord[] = signals.map((signal) => ({
				type: "signal.recorded",
				at: new Date().toISOString(),
				signal,
			}));
			appendLedger(path, records);
			signalsRecorded += signals.length;
		}

		const data: TasteCoverageData = { coversUpToId, signalCount: signals?.length ?? 0 };
		pi.appendEntry(TASTE_COVERAGE, data);

		const next = indexById.get(coversUpToId);
		if (next === undefined) {
			reachedEnd = true;
			break;
		}
		cursor = next;
		chunks++;
	}

	return { chunks, signalsRecorded, reachedEnd };
}
