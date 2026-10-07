/** Minimal shape of a pi session entry, mirroring what `sessionManager.getBranch()` returns. */
export interface SessionEntry {
	type: string;
	id: string;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	data?: unknown;
	details?: unknown;
}
