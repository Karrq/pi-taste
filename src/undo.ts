import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { foldLedger } from "./ledger/fold.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "./ledger/paths.js";
import { isLedgerRecord, type LedgerRecord } from "./ledger/types.js";

export interface UndoResult {
	/** The op ids removed, most recent first. */
	opIds: string[];
	/** Ledger records deleted across both files. */
	recordsRemoved: number;
	/** True when the ledgers changed (or would change on a dry run). */
	changed: boolean;
	/** One entry per record that is removed or would be removed. */
	records: UndoRecordPreview[];
}

export interface UndoRecordPreview {
	file: "project" | "global";
	type: LedgerRecord["type"];
	summary: string;
	/** For a merge: the entries restored when the merge is removed. */
	sources?: UndoSourcePreview[];
}

export interface UndoSourcePreview {
	id: string;
	category: string;
	content: string;
}

function summarize(record: LedgerRecord): string {
	switch (record.type) {
		case "signal.recorded":
			return `signal: ${record.signal.content}`;
		case "entry.upserted":
			return `entry [${record.entry.category}] ${record.entry.content}`;
		case "entry.retracted":
			return `retract ${record.entryId}: ${record.reason}`;
		case "entry.merged":
			return `merge [${record.entry.category}] ${record.entry.content}`;
	}
}

export interface UndoOptions {
	/** Report what would be removed without rewriting the ledgers. */
	dryRun?: boolean;
}

interface LedgerLine {
	raw: string;
	record?: LedgerRecord;
}

/**
 * Read a ledger as raw lines, keeping unparseable lines so a rewrite does not
 * silently drop a line the reader would otherwise skip.
 */
function readLines(path: string): LedgerLine[] {
	if (!existsSync(path)) return [];
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const lines: LedgerLine[] = [];
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(raw);
			lines.push(isLedgerRecord(parsed) ? { raw, record: parsed } : { raw });
		} catch {
			lines.push({ raw });
		}
	}
	return lines;
}

function writeLines(path: string, lines: readonly LedgerLine[]): void {
	writeFileSync(path, lines.length > 0 ? `${lines.map((line) => line.raw).join("\n")}\n` : "", "utf-8");
}

/** Distinct op ids in `lines`, with the latest `at` and scan order seen for each. */
function opIdsIn(lines: readonly LedgerLine[], startOrder: number): { ops: Map<string, OpRef>; order: number } {
	let order = startOrder;
	const ops = new Map<string, OpRef>();
	for (const line of lines) {
		const record = line.record;
		if (!record?.opId) continue;
		order += 1;
		const previous = ops.get(record.opId);
		if (!previous || record.at > previous.at || (record.at === previous.at && order > previous.order)) {
			ops.set(record.opId, { at: record.at, order });
		}
	}
	return { ops, order };
}

interface OpRef {
	at: string;
	order: number;
}

/**
 * Remove the last `count` command operations from the project and global
 * ledgers. An operation is one command invocation identified by the `opId`
 * stamped on every record it wrote, so undoing one `/taste prune` removes both
 * its merges and its retractions even though they span several records.
 *
 * This rewrites the ledger files. That is the point: a merge creates aliases and
 * tombstones that append-only records cannot fully reverse, so undo has to
 * delete the records rather than compensate for them.
 */
export function undoLastOps(cwd: string, count = 1, options: UndoOptions = {}): UndoResult {
	const targets = Math.max(1, Math.floor(count));
	const files = [
		{ path: ledgerPath(projectTasteDir(cwd)), label: "project" as const },
		{ path: ledgerPath(globalTasteDir()), label: "global" as const },
	];
	const loaded = files.map(({ path, label }) => ({ path, label, lines: readLines(path) }));

	const ops = new Map<string, OpRef>();
	let order = 0;
	for (const { lines } of loaded) {
		const scanned = opIdsIn(lines, order);
		order = scanned.order;
		for (const [opId, ref] of scanned.ops) {
			const previous = ops.get(opId);
			if (!previous || ref.at > previous.at || (ref.at === previous.at && ref.order > previous.order)) {
				ops.set(opId, ref);
			}
		}
	}
	if (ops.size === 0) return { opIds: [], recordsRemoved: 0, changed: false, records: [] };

	const ordered = [...ops.entries()]
		.sort((a, b) => b[1].at.localeCompare(a[1].at) || b[1].order - a[1].order)
		.slice(0, targets);
	const selected = new Set(ordered.map(([opId]) => opId));

	let recordsRemoved = 0;
	let changed = false;
	const records: UndoRecordPreview[] = [];
	for (const { path, label, lines } of loaded) {
		// Fold each ledger so a merge can list the sources it will restore.
		const folded = foldLedger(
			lines.map((line) => line.record).filter((record): record is LedgerRecord => record !== undefined),
		);
		const kept = lines.filter((line) => {
			const record = line.record;
			if (!record?.opId || !selected.has(record.opId)) return true;
			recordsRemoved += 1;
			const preview: UndoRecordPreview = { file: label, type: record.type, summary: summarize(record) };
			if (record.type === "entry.merged") {
				preview.sources = record.fromIds.map((fromId) => {
					const source = folded.entriesById.get(fromId);
					return source
						? { id: source.id, category: source.category, content: source.content }
						: { id: fromId, category: "?", content: "(not found in ledger)" };
				});
			}
			records.push(preview);
			return false;
		});
		if (kept.length !== lines.length) {
			changed = true;
			if (!options.dryRun) writeLines(path, kept);
		}
	}

	return { opIds: ordered.map(([opId]) => opId), recordsRemoved, changed, records };
}
