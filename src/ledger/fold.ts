import type { LedgerRecord, Signal, TasteEntry } from "./types.js";

export interface FoldedLedger {
	signalsById: Map<string, Signal>;
	/** Latest upsert per entry id, retracted or not. */
	entriesById: Map<string, TasteEntry>;
	retractedIds: Set<string>;
	activeEntries: TasteEntry[];
}

/**
 * Fold an append-only ledger into current state. Upserts are last-write-wins
 * per id; a retraction tombstones an entry until the same id is upserted again.
 */
export function foldLedger(records: readonly LedgerRecord[]): FoldedLedger {
	const signalsById = new Map<string, Signal>();
	const entriesById = new Map<string, TasteEntry>();
	const retractedIds = new Set<string>();

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
		}
	}

	const activeEntries = Array.from(entriesById.values()).filter((entry) => !retractedIds.has(entry.id));
	return { signalsById, entriesById, retractedIds, activeEntries };
}
