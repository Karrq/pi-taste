import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { TASTE_CATEGORIES } from "./agents/distill/questions.js";
import { runReflection, type MergeProposal } from "./agents/reflect/agent.js";
import {
	appendLedger,
	foldLedger,
	readLedger,
	tasteEntryId,
	type LedgerRecord,
	type TasteEntry,
} from "./ledger/index.js";
import { ledgerPath, projectTasteDir } from "./ledger/paths.js";
import { resolveTasteModel } from "./model-resolver.js";
import type { Runtime } from "./runtime.js";
import { nowTimestamp, truncateRecordContent } from "./serialize.js";

export type { MergeProposal };

const CATEGORY_SET: ReadonlySet<string> = new Set(Object.keys(TASTE_CATEGORIES));

function singleLine(content: string): string {
	return content.replace(/\s+/gu, " ").trim();
}

/**
 * Validate model proposals against the entries actually offered. A proposal
 * citing an unknown id is dropped whole, an entry may only be merged once, and
 * an unrecognized category falls back to `general` rather than being invented.
 */
export function normalizeProposals(
	raw: readonly MergeProposal[],
	entries: ReadonlyMap<string, TasteEntry>,
	categories: ReadonlySet<string> = CATEGORY_SET,
): MergeProposal[] {
	const used = new Set<string>();
	const proposals: MergeProposal[] = [];
	for (const proposal of raw) {
		const fromIds = [...new Set(proposal.fromIds)];
		if (fromIds.length < 2) continue;
		if (!fromIds.every((id) => entries.has(id))) continue;
		if (fromIds.some((id) => used.has(id))) continue;
		const content = truncateRecordContent(singleLine(proposal.content));
		if (!content) continue;
		const category = categories.has(proposal.category) ? proposal.category : "general";
		for (const id of fromIds) used.add(id);
		proposals.push({ fromIds, content, category });
	}
	return proposals;
}

/**
 * The consolidated entry. Confidence is the maximum of its sources, not their
 * probabilistic OR: a merge re-words the same evidence, so OR would inflate the
 * profile without any new observation.
 */
export function buildMergedEntry(proposal: MergeProposal, sources: readonly TasteEntry[], now: string): TasteEntry {
	const signalIds = [...new Set(sources.flatMap((source) => source.signalIds))];
	const projectKeys = [...new Set(sources.flatMap((source) => source.projectKeys))];
	const createdAt = sources.map((source) => source.createdAt).sort()[0] ?? now;
	return {
		id: tasteEntryId(proposal.content),
		content: proposal.content,
		category: proposal.category,
		confidence: Math.max(...sources.map((source) => source.confidence)),
		explicit: sources.some((source) => source.explicit),
		scope: "project",
		signalIds,
		projectKeys,
		createdAt,
		updatedAt: now,
	};
}

export interface ReflectCtx {
	cwd: string;
	model?: unknown;
	modelRegistry: unknown;
	thinkingLevel?: ModelThinkingLevel;
}

export interface ReflectDeps {
	runReflection?: typeof runReflection;
	resolveModel?: typeof resolveTasteModel;
}

export interface ReflectSummary {
	entriesConsidered: number;
	/** Consolidations written. */
	merged: number;
	/** Source entries absorbed into a consolidation. */
	entriesRetracted: number;
	/** True when the active pool was larger than the reflection budget. */
	truncated: boolean;
}

/**
 * Consolidate the project's active entries via one reflection call, then write
 * `entry.merged` records. Callers run this explicitly; it never runs as part of
 * extraction.
 */
export async function runTasteReflect(
	runtime: Runtime,
	ctx: ReflectCtx,
	deps: ReflectDeps = {},
): Promise<ReflectSummary> {
	runtime.ensureConfig(ctx.cwd);
	const path = ledgerPath(projectTasteDir(ctx.cwd));
	const active = foldLedger(readLedger(path)).activeEntries;
	if (active.length < 2) {
		return { entriesConsidered: active.length, merged: 0, entriesRetracted: 0, truncated: false };
	}

	const considered = [...active]
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, runtime.config.reflectMaxEntries);
	const truncated = considered.length < active.length;

	const resolveModel = deps.resolveModel ?? resolveTasteModel;
	const resolved = await resolveModel(runtime, {
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		stage: "reflect",
		thinkingLevel: ctx.thinkingLevel,
	});
	if (!resolved) throw new Error("no model available for taste reflection");

	const reflect = deps.runReflection ?? runReflection;
	const raw = await reflect({
		model: resolved.model,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		env: resolved.env,
		entries: considered,
		maxTurns: runtime.config.agentMaxTurns,
		maxOutputTokens: runtime.config.agentMaxTokens,
		thinkingLevel: resolved.thinking,
		modelRegistry: ctx.modelRegistry as never,
	});

	const allowed = new Map(considered.map((entry) => [entry.id, entry]));
	const proposals = normalizeProposals(raw ?? [], allowed);
	const at = new Date().toISOString();
	const records: LedgerRecord[] = [];
	let entriesRetracted = 0;
	for (const proposal of proposals) {
		const sources = proposal.fromIds.map((id) => allowed.get(id) as TasteEntry);
		const entry = buildMergedEntry(proposal, sources, at);
		// The rewritten statement can match one source word-for-word. That source
		// keeps the id and must not be tombstoned, so it is dropped from `fromIds`.
		const fromIds = proposal.fromIds.filter((id) => id !== entry.id);
		if (fromIds.length === 0) continue;
		records.push({ type: "entry.merged", at, entry, fromIds });
		entriesRetracted += fromIds.length;
	}
	if (records.length > 0) appendLedger(path, records);

	return { entriesConsidered: considered.length, merged: records.length, entriesRetracted, truncated };
}
