import { createHash, randomUUID } from "node:crypto";

export function hashId(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/**
 * Groups every record a single command invocation writes, so `/taste undo` can
 * remove one user action even when it produced several records across ledgers.
 */
export function newOpId(): string {
	return randomUUID();
}
