import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DistilledCandidate } from "./agents/distill/index.js";
import { foldLedger } from "./ledger/fold.js";
import { GLOBAL_TASTE_KEY, globalTasteDir, ledgerPath, projectTasteDir, tasteRootDir } from "./ledger/paths.js";
import { readLedger } from "./ledger/store.js";
import { tasteEntryId, type LedgerRecord, type TasteEntry } from "./ledger/types.js";

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * Probabilistic OR: a preference observed twice is more confident than once, with
 * diminishing returns so repeated observation cannot pin confidence at 1 unless
 * the evidence itself is certain.
 */
export function combineConfidence(previous: number | undefined, next: number): number {
	if (previous === undefined) return clamp01(next);
	return clamp01(1 - (1 - previous) * (1 - next));
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

export interface ProjectAggregate {
	projectKeys: string[];
	confidence: number;
}

/**
 * Scan every project ledger for the same entry id. This is what turns recurrence
 * across projects into global promotion evidence; the global layer is otherwise
 * unaware of what other projects learned.
 */
export function aggregateAcrossProjects(entryId: string): ProjectAggregate {
	const root = tasteRootDir();
	if (!existsSync(root)) return { projectKeys: [], confidence: 0 };
	const projectKeys: string[] = [];
	let confidence = 0;
	for (const dirent of readdirSync(root, { withFileTypes: true })) {
		if (!dirent.isDirectory() || dirent.name === GLOBAL_TASTE_KEY) continue;
		const entry = foldLedger(readLedger(ledgerPath(join(root, dirent.name)))).entriesById.get(entryId);
		if (!entry) continue;
		projectKeys.push(...entry.projectKeys);
		confidence = Math.max(confidence, entry.confidence);
	}
	return { projectKeys, confidence };
}

export interface ReconcileResult {
	projectRecords: LedgerRecord[];
	globalRecords: LedgerRecord[];
	entry: TasteEntry;
}

/** Build the global-layer entry for a preference, preserving the original creation time. */
export function buildGlobalEntry(args: {
	entry: TasteEntry;
	projectKeys: readonly string[];
	confidence: number;
	now: string;
	existing?: TasteEntry;
}): TasteEntry {
	return {
		...args.entry,
		scope: "global",
		confidence: clamp01(args.confidence),
		projectKeys: uniqueStrings(args.projectKeys),
		createdAt: args.existing?.createdAt ?? args.entry.createdAt,
		updatedAt: args.now,
	};
}

/**
 * Merge one distilled candidate into the project ledger, then promote it to the
 * global ledger when the classifier judged it general or when it has now been
 * observed in `promoteAtProjectCount` distinct projects.
 */
export function reconcileCandidate(args: {
	cwd: string;
	candidate: DistilledCandidate;
	projectKey: string;
	promoteAtProjectCount: number;
	now: string;
}): ReconcileResult {
	const id = tasteEntryId(args.candidate.content);
	const projectPath = ledgerPath(projectTasteDir(args.cwd));
	const existing = foldLedger(readLedger(projectPath)).entriesById.get(id);

	const signalIds = uniqueStrings([...(existing?.signalIds ?? []), args.candidate.signal.id]);
	const projectKeys = uniqueStrings([...(existing?.projectKeys ?? []), args.projectKey]);
	const confidence = combineConfidence(existing?.confidence, args.candidate.confidence);

	const entry: TasteEntry = {
		id,
		content: args.candidate.content,
		category: args.candidate.category,
		confidence,
		explicit: (existing?.explicit ?? false) || args.candidate.explicit,
		scope: "project",
		signalIds,
		projectKeys,
		createdAt: existing?.createdAt ?? args.now,
		updatedAt: args.now,
	};
	const projectRecords: LedgerRecord[] = [{ type: "entry.upserted", at: args.now, entry }];

	const aggregate = aggregateAcrossProjects(id);
	const mergedKeys = uniqueStrings([...aggregate.projectKeys, ...projectKeys]);
	const shouldPromote = args.candidate.general || mergedKeys.length >= args.promoteAtProjectCount;
	const globalRecords: LedgerRecord[] = [];
	if (shouldPromote) {
		const globalPath = ledgerPath(globalTasteDir());
		const globalExisting = foldLedger(readLedger(globalPath)).entriesById.get(id);
		globalRecords.push({
			type: "entry.upserted",
			at: args.now,
			entry: buildGlobalEntry({
				entry,
				projectKeys: mergedKeys,
				confidence: Math.max(confidence, aggregate.confidence),
				now: args.now,
				...(globalExisting ? { existing: globalExisting } : {}),
			}),
		});
	}

	return { projectRecords, globalRecords, entry };
}
