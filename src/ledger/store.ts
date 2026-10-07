import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isLedgerRecord, type LedgerRecord } from "./types.js";

/**
 * Read every valid record from an append-only NDJSON ledger. Malformed lines
 * are skipped rather than failing the read, so one bad write never makes the
 * whole ledger unreadable.
 */
export function readLedger(path: string): LedgerRecord[] {
	if (!existsSync(path)) return [];
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const records: LedgerRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isLedgerRecord(parsed)) records.push(parsed);
		} catch {
			// A partial or corrupt line is ignored; the rest of the ledger stands.
		}
	}
	return records;
}

/** Append records, creating the ledger's directory on first write. */
export function appendLedger(path: string, records: readonly LedgerRecord[]): void {
	if (records.length === 0) return;
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
}
