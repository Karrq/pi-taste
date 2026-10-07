import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { foldLedger, type TasteEntry } from "./ledger/index.js";
import { encodeCwd, globalTasteDir, ledgerPath, projectTasteDir, tasteFilePath } from "./ledger/paths.js";
import { readLedger } from "./ledger/store.js";
import { renderTasteMarkdown } from "./render/taste-markdown.js";
import { mergeTasteEntries } from "./render/taste-section.js";

export interface ExportResult {
	projectPath: string;
	globalPath: string;
	projectCount: number;
	globalCount: number;
}

function writeMarkdown(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

/**
 * Write the human-readable profile next to each ledger. The project file holds
 * the merged view the agent actually sees; the global file holds only the
 * global layer.
 */
export function exportTasteMarkdown(cwd: string): ExportResult {
	const projectEntries: TasteEntry[] = foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries;
	const globalEntries: TasteEntry[] = foldLedger(readLedger(ledgerPath(globalTasteDir()))).activeEntries;
	const generatedAt = new Date().toISOString();

	const projectPath = tasteFilePath(projectTasteDir(cwd));
	const globalPath = tasteFilePath(globalTasteDir());
	writeMarkdown(
		projectPath,
		renderTasteMarkdown(mergeTasteEntries(projectEntries, globalEntries), {
			title: `Taste: ${encodeCwd(cwd)}`,
			generatedAt,
		}),
	);
	writeMarkdown(globalPath, renderTasteMarkdown(globalEntries, { title: "Global taste", generatedAt }));

	return {
		projectPath,
		globalPath,
		projectCount: projectEntries.length,
		globalCount: globalEntries.length,
	};
}
