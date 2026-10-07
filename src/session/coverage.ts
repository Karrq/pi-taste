import { estimateEntryTokens } from "../tokens.js";
import type { SessionEntry } from "./types.js";

/** Session custom entry recording how far extraction has processed the branch. */
export const TASTE_COVERAGE = "taste.coverage";

export interface TasteCoverageData {
	coversUpToId: string;
	signalCount: number;
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

/** Index of the furthest source entry extraction has covered, or -1. */
export function latestCoverageIndex(entries: readonly SessionEntry[]): number {
	const idToIndex = entryIndexById(entries);
	let latest = -1;
	for (const entry of entries) {
		if (!isValidCoverageEntry(entry)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex !== undefined && coveredIndex > latest) latest = coveredIndex;
	}
	return latest;
}

export function latestCoverageMarkerId(entries: readonly SessionEntry[]): string | undefined {
	const idToIndex = entryIndexById(entries);
	let latestIndex = -1;
	let latestMarkerId: string | undefined;
	for (const entry of entries) {
		if (!isValidCoverageEntry(entry)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex !== undefined && coveredIndex > latestIndex) {
			latestIndex = coveredIndex;
			latestMarkerId = entry.data.coversUpToId;
		}
	}
	return latestMarkerId;
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
