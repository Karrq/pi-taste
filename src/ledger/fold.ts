import type { LedgerRecord, Signal, TasteEntry } from "./types.js";

export interface FoldedLedger {
	signalsById: Map<string, Signal>;
	/** Latest upsert per entry id, retracted or not. */
	entriesById: Map<string, TasteEntry>;
	retractedIds: Set<string>;
	/** Consolidation redirects: a historical entry id to the id that replaced it. */
	aliases: Map<string, string>;
	activeEntries: TasteEntry[];
}

/**
 * Follow consolidation redirects to the entry id that currently owns the
 * preference. Chains are walked to the terminal id so merges of merges resolve,
 * and a cycle guard keeps a corrupt ledger from looping forever.
 */
export function resolveAliasId(folded: FoldedLedger, id: string): string {
	let current = id;
	const seen = new Set<string>();
	while (folded.aliases.has(current) && !seen.has(current)) {
		seen.add(current);
		current = folded.aliases.get(current) as string;
	}
	return current;
}

/**
 * Fold an append-only ledger into current state. Upserts are last-write-wins
 * per id; a retraction tombstones an entry until the same id is upserted again.
 * A merge tombstones its sources and aliases them to the consolidated entry.
 */
export function foldLedger(records: readonly LedgerRecord[]): FoldedLedger {
	const signalsById = new Map<string, Signal>();
	const entriesById = new Map<string, TasteEntry>();
	const retractedIds = new Set<string>();
	const aliases = new Map<string, string>();

	for (const record of records) {
		switch (record.type) {
			case "signal.recorded":
				signalsById.set(record.signal.id, record.signal);
				break;
			case "entry.upserted":
				entriesById.set(record.entry.id, record.entry);
				// A fresh upsert revives an id that was previously retracted, so a
				// preference the user re-states is not silently suppressed forever.
				retractedIds.delete(record.entry.id);
				break;
			case "entry.retracted":
				retractedIds.add(record.entryId);
				break;
			case "entry.merged":
				entriesById.set(record.entry.id, record.entry);
				retractedIds.delete(record.entry.id);
				for (const fromId of record.fromIds) {
					aliases.set(fromId, record.entry.id);
					retractedIds.add(fromId);
				}
				break;
		}
	}

	const activeEntries = Array.from(entriesById.values()).filter((entry) => !retractedIds.has(entry.id));
	return { signalsById, entriesById, retractedIds, aliases, activeEntries };
}
