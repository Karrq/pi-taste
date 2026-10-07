import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const TASTE_DIR_NAME = "taste";
export const GLOBAL_TASTE_KEY = "global";
export const LEDGER_FILE_NAME = "ledger.ndjson";
export const TASTE_FILE_NAME = "taste.md";

/**
 * Encodes a working directory into a safe leaf name. Mirrors pi's session
 * directory encoding (`~/.pi/agent/sessions/<encoded-cwd>/`) so a project's
 * taste directory sits beside its sessions and a path-based key stays stable
 * across runs on the same machine.
 */
export function encodeCwd(cwd: string): string {
	const resolved = resolve(cwd);
	return `--${resolved.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
}

export function tasteRootDir(): string {
	return join(getAgentDir(), TASTE_DIR_NAME);
}

export function projectTasteDir(cwd: string): string {
	return join(tasteRootDir(), encodeCwd(cwd));
}

export function globalTasteDir(): string {
	return join(tasteRootDir(), GLOBAL_TASTE_KEY);
}

export function ledgerPath(dir: string): string {
	return join(dir, LEDGER_FILE_NAME);
}

export function tasteFilePath(dir: string): string {
	return join(dir, TASTE_FILE_NAME);
}
