import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SystemOneMode } from "../../config.js";
import { tasteRootDir } from "../../ledger/paths.js";

export interface DistillDecisionRow {
	isPreference: boolean;
	category: string;
	confidence: number;
	explicit: boolean;
	general: boolean;
}

/**
 * One row per classified signal, written regardless of `debugLog`. Carries ids
 * and numbers only, never signal content, so the calibration log stays free of
 * conversation text. In shadow mode it pairs the classifier verdict with the
 * heuristic verdict that was actually applied, which is the label a calibration
 * map would be fitted against.
 */
export interface DistillScoreRow {
	ts: string;
	sessionId?: string;
	signalId: string;
	mode: SystemOneMode;
	classifier?: DistillDecisionRow;
	heuristic: DistillDecisionRow;
	applied: "classifier" | "heuristic";
}

const SAFE_SESSION_ID = /[^a-zA-Z0-9._-]+/gu;

function safeSessionId(sessionId: string | undefined): string {
	if (!sessionId) return "unknown-session";
	const safe = sessionId.replace(SAFE_SESSION_ID, "_").slice(0, 120);
	return safe.length > 0 ? safe : "unknown-session";
}

export function distillScoresPath(sessionId: string | undefined): string {
	return join(tasteRootDir(), "distill-scores", `${safeSessionId(sessionId)}.ndjson`);
}

/** Append one run's rows. Never throws: a failed write must not change behavior. */
export function appendDistillScores(sessionId: string | undefined, rows: readonly DistillScoreRow[]): boolean {
	if (rows.length === 0) return false;
	try {
		const path = distillScoresPath(sessionId);
		mkdirSync(join(tasteRootDir(), "distill-scores"), { recursive: true });
		appendFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}
