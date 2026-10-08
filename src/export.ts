import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { foldLedger, type TasteEntry } from "./ledger/index.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "./ledger/paths.js";
import { readLedger } from "./ledger/store.js";
import { renderTasteMarkdown } from "./render/taste-markdown.js";
import { mergeTasteEntries } from "./render/taste-section.js";

export interface ExportResult {
	path: string;
	projectCount: number;
	globalCount: number;
}

function writeMarkdown(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

/**
 * Write the human-readable profile to `<cwd>/taste.md`. This is the only place a
 * markdown file is produced: the ledgers stay the source of truth, and the file
 * is regenerated on each export rather than stored.
 */
export function exportTasteMarkdown(cwd: string): ExportResult {
	const projectEntries: TasteEntry[] = foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries;
	const globalEntries: TasteEntry[] = foldLedger(readLedger(ledgerPath(globalTasteDir()))).activeEntries;
	const path = join(cwd, "taste.md");
	writeMarkdown(
		path,
		renderTasteMarkdown(mergeTasteEntries(projectEntries, globalEntries), {
			title: "Taste",
			generatedAt: new Date().toISOString(),
		}),
	);
	return { path, projectCount: projectEntries.length, globalCount: globalEntries.length };
}
