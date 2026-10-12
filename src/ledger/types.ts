import { hashId } from "../ids.js";

export const SIGNAL_KINDS = ["stated", "correction", "explicit"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const TASTE_SCOPES = ["project", "global"] as const;
export type TasteScope = (typeof TASTE_SCOPES)[number];

/**
 * A raw piece of evidence that the user expressed or corrected a preference.
 * Signals are the observation layer: factual, sourced, not yet generalizable.
 */
export interface Signal {
	/** Deterministic id: hash of the normalized content. */
	id: string;
	/** Single-line plain prose. */
	content: string;
	/** Local `YYYY-MM-DD HH:MM`. */
	timestamp: string;
	kind: SignalKind;
	/** Encoded working directory this signal was observed in. */
	projectKey: string;
	/** Session entry ids that support this signal. */
	sourceEntryIds: string[];
	sessionId?: string;
}

/**
 * A durable coding preference distilled from one or more signals. The id is
 * content-derived so the same preference recurring in a later session or a
 * different project maps onto the same entry and raises its confidence instead
 * of creating a duplicate.
 */
export interface TasteEntry {
	id: string;
	content: string;
	category: string;
	/** 0..1. Calibrated when the classifier produced it; 1 for explicit records. */
	confidence: number;
	/** True when the user stated it directly rather than it being inferred. */
	explicit: boolean;
	scope: TasteScope;
	signalIds: string[];
	/** Distinct project keys this preference has been observed in. */
	projectKeys: string[];
	createdAt: string;
	updatedAt: string;
}

/** A command invocation id, shared by every record that invocation writes. */
export interface LedgerOp {
	/** Set when the record came from a user command, so `/taste undo` can group it. */
	opId?: string;
}

export type LedgerRecord =
	| ({ type: "signal.recorded"; at: string; signal: Signal } & LedgerOp)
	| ({ type: "entry.upserted"; at: string; entry: TasteEntry } & LedgerOp)
	| ({ type: "entry.retracted"; at: string; entryId: string; reason: string } & LedgerOp)
	/** A consolidation: `entry` replaces `fromIds`, which are tombstoned and aliased to it. */
	| ({ type: "entry.merged"; at: string; entry: TasteEntry; fromIds: string[] } & LedgerOp);

/** Stable identity for a taste statement: case, whitespace and trailing punctuation insensitive. */
export function normalizeTasteContent(content: string): string {
	return content.trim().toLowerCase().replace(/\s+/gu, " ").replace(/[.!?]+$/u, "");
}

/** The entry id the same preference always resolves to. */
export function tasteEntryId(content: string): string {
	return hashId(normalizeTasteContent(content));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyString);
}

function isSignalKind(value: unknown): value is SignalKind {
	return typeof value === "string" && (SIGNAL_KINDS as readonly string[]).includes(value);
}

function isTasteScope(value: unknown): value is TasteScope {
	return typeof value === "string" && (TASTE_SCOPES as readonly string[]).includes(value);
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isSignal(value: unknown): value is Signal {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.id)
		&& isNonEmptyString(value.content)
		&& isNonEmptyString(value.timestamp)
		&& isSignalKind(value.kind)
		&& isNonEmptyString(value.projectKey)
		&& isNonEmptyStringArray(value.sourceEntryIds)
		&& (value.sessionId === undefined || isNonEmptyString(value.sessionId))
	);
}

export function isTasteEntry(value: unknown): value is TasteEntry {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.id)
		&& isNonEmptyString(value.content)
		&& !/[\r\n]/u.test(value.content)
		&& isNonEmptyString(value.category)
		&& isProbability(value.confidence)
		&& typeof value.explicit === "boolean"
		&& isTasteScope(value.scope)
		&& isNonEmptyStringArray(value.signalIds)
		&& isNonEmptyStringArray(value.projectKeys)
		&& isNonEmptyString(value.createdAt)
		&& isNonEmptyString(value.updatedAt)
	);
}

export function isLedgerRecord(value: unknown): value is LedgerRecord {
	if (!isRecord(value)) return false;
	if (!isNonEmptyString(value.at)) return false;
	switch (value.type) {
		case "signal.recorded":
			return isSignal(value.signal);
		case "entry.upserted":
			return isTasteEntry(value.entry);
		case "entry.retracted":
			return isNonEmptyString(value.entryId) && isNonEmptyString(value.reason);
		case "entry.merged":
			return (
				isTasteEntry(value.entry)
				&& isNonEmptyStringArray(value.fromIds)
				&& value.fromIds.length > 0
				&& !value.fromIds.includes(value.entry.id)
			);
		default:
			return false;
	}
}
