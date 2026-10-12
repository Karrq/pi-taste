import { appendLedger, tasteEntryId, type LedgerRecord, type Signal, type TasteEntry } from "./ledger/index.js";
import { encodeCwd, globalTasteDir, ledgerPath, projectTasteDir } from "./ledger/paths.js";
import { reconcileCandidate } from "./reconcile.js";
import { localTimestamp } from "./time.js";

/** Synthetic source id for a `/taste remember` signal, which has no session entry. */
export const REMEMBER_SOURCE_ID = "user:taste-remember";

export interface RememberArgs {
	cwd: string;
	text: string;
	/** Promotion still follows the normal recurrence rule. */
	promoteAtProjectCount: number;
	sessionId?: string;
	now?: Date;
	opId?: string;
}

export interface RememberResult {
	signal: Signal;
	entry: TasteEntry;
	globalRecords: LedgerRecord[];
}

/**
 * The explicit path: record a preference the user stated in their own words,
 * with no extraction or classifier pass. Its signal counts as `explicit` and its
 * entry starts at confidence 1, but it merges with an existing entry for the
 * same statement and still promotes on recurrence.
 */
export function rememberPreference(args: RememberArgs): RememberResult {
	const date = args.now ?? new Date();
	const at = date.toISOString();
	const projectKey = encodeCwd(args.cwd);
	const content = args.text.trim();
	const signal: Signal = {
		id: tasteEntryId(content),
		content,
		timestamp: localTimestamp(date),
		kind: "explicit",
		projectKey,
		sourceEntryIds: [REMEMBER_SOURCE_ID],
		...(args.sessionId ? { sessionId: args.sessionId } : {}),
	};

	const { projectRecords, globalRecords, entry } = reconcileCandidate({
		cwd: args.cwd,
		candidate: { content, category: "general", confidence: 1, explicit: true, general: false, signal },
		projectKey,
		promoteAtProjectCount: args.promoteAtProjectCount,
		now: at,
		...(args.opId ? { opId: args.opId } : {}),
	});

	const op = args.opId ? { opId: args.opId } : {};
	appendLedger(ledgerPath(projectTasteDir(args.cwd)), [
		{ type: "signal.recorded", at, signal, ...op },
		...projectRecords,
	]);
	if (globalRecords.length > 0) appendLedger(ledgerPath(globalTasteDir()), globalRecords);

	return { signal, entry, globalRecords };
}
