import { estimateEntryTokens } from "../tokens.js";
import type { SessionEntry } from "./types.js";

/** Session custom entry recording how far extraction has processed the branch. */
export const TASTE_COVERAGE = "taste.coverage";
/** Session custom entry rewinding the coverage watermark after an undo. */
export const TASTE_COVERAGE_RESET = "taste.coverage.reset";

export interface TasteCoverageData {
	coversUpToId: string;
	signalCount: number;
	/** The command invocation that wrote this marker, so `/taste undo` can reverse it. */
	opId?: string;
}

export interface TasteCoverageResetData {
	/** Rewind to this marker; omitted means the branch has no covered span. */
	coversUpToId?: string;
}

const SOURCE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export function isSourceEntry(entry: SessionEntry): boolean {
	return SOURCE_ENTRY_TYPES.has(entry.type);
}

export function entryIndexById(entries: readonly SessionEntry[]): Map<string, number> {
	const idToIndex = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIndex.set(entries[i].id, i);
	return idToIndex;
}

export function isTasteCoverageData(value: unknown): value is TasteCoverageData {
	return (
		typeof value === "object"
		&& value !== null
		&& typeof (value as { coversUpToId?: unknown }).coversUpToId === "string"
	);
}

function isValidCoverageEntry(entry: SessionEntry): entry is SessionEntry & { data: TasteCoverageData } {
	return entry.type === "custom" && entry.customType === TASTE_COVERAGE && isTasteCoverageData(entry.data);
}

export function isTasteCoverageEntry(entry: SessionEntry): entry is SessionEntry & { data: TasteCoverageData } {
	return isValidCoverageEntry(entry);
}

function isValidCoverageResetEntry(entry: SessionEntry): entry is SessionEntry & { data: TasteCoverageResetData } {
	if (entry.type !== "custom" || entry.customType !== TASTE_COVERAGE_RESET) return false;
	const data = entry.data as TasteCoverageResetData | undefined;
	return data === undefined || data.coversUpToId === undefined || typeof data.coversUpToId === "string";
}

interface CoverageWatermark {
	index: number;
	markerId?: string;
}

/**
 * Walk the branch in order. A reset overwrites the watermark; a normal coverage
 * marker only moves it forward. That lets an undo rewind coverage without
 * deleting the marker it is undoing.
 */
function walkCoverage(entries: readonly SessionEntry[]): CoverageWatermark {
	const idToIndex = entryIndexById(entries);
	let index = -1;
	let markerId: string | undefined;
	for (const entry of entries) {
		if (isValidCoverageEntry(entry)) {
			const coveredIndex = idToIndex.get(entry.data.coversUpToId);
			if (coveredIndex !== undefined && coveredIndex > index) {
				index = coveredIndex;
				markerId = entry.data.coversUpToId;
			}
		} else if (isValidCoverageResetEntry(entry)) {
			const marker = entry.data.coversUpToId;
			const coveredIndex = marker === undefined ? undefined : idToIndex.get(marker);
			index = coveredIndex ?? -1;
			markerId = coveredIndex === undefined ? undefined : marker;
		}
	}
	return { index, markerId };
}

/** Index of the furthest source entry extraction has covered, or -1. */
export function latestCoverageIndex(entries: readonly SessionEntry[]): number {
	return walkCoverage(entries).index;
}

export function latestCoverageMarkerId(entries: readonly SessionEntry[]): string | undefined {
	return walkCoverage(entries).markerId;
}

/** Source entries after an index, in branch order. */
export function sourceEntriesAfter(entries: readonly SessionEntry[], index: number): SessionEntry[] {
	return entries.slice(Math.max(0, index + 1)).filter(isSourceEntry);
}

export function rawTokensSinceCoverage(entries: readonly SessionEntry[]): number {
	const index = latestCoverageIndex(entries);
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) {
		if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export interface CoverageUndoPlan {
	/** Coverage markers written by the undone operations. */
	removed: number;
	/** Marker to rewind to; omitted means nothing remains covered. */
	coversUpToId?: string;
}

/**
 * Decide how to rewind coverage after undoing `opIds`. Returns undefined when
 * none of those operations wrote a coverage marker, so undo leaves the
 * watermark alone. The rewind target is the watermark implied by the markers
 * that remain, which is exactly the state before the undone run.
 */
export function planCoverageUndo(
	entries: readonly SessionEntry[],
	opIds: readonly string[],
): CoverageUndoPlan | undefined {
	const targetOps = new Set(opIds);
	if (targetOps.size === 0) return undefined;

	let removed = 0;
	const remaining: SessionEntry[] = [];
	for (const entry of entries) {
		if (isTasteCoverageEntry(entry) && entry.data.opId !== undefined && targetOps.has(entry.data.opId)) {
			removed += 1;
			continue;
		}
		remaining.push(entry);
	}
	if (removed === 0) return undefined;

	const markerId = latestCoverageMarkerId(remaining);
	return markerId === undefined ? { removed } : { removed, coversUpToId: markerId };
}
