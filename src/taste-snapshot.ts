import { foldLedger } from "./ledger/fold.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "./ledger/paths.js";
import { readLedger } from "./ledger/store.js";
import { mergeTasteEntries, renderTasteSection } from "./render/taste-section.js";
import type { Runtime } from "./runtime.js";

/**
 * Recompute the injected `<taste>` snapshot from the project and global ledgers.
 *
 * Callers are deliberately few: session start, after a compaction, and an
 * explicit `/taste enable`/`/taste remember`. Ordinary turns must not call this,
 * because changing the injected text invalidates the provider's cached prefix.
 * `/taste consolidate` writes the ledger but does not refresh the snapshot; the
 * effect appears at the next compaction.
 */
export function refreshTasteSnapshot(runtime: Runtime, cwd: string): string | undefined {
	runtime.ensureConfig(cwd);
	if (!runtime.config.enabled) {
		runtime.tasteSnapshot = undefined;
		return undefined;
	}
	const project = foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries;
	const global = foldLedger(readLedger(ledgerPath(globalTasteDir()))).activeEntries;
	runtime.tasteSnapshot = renderTasteSection(mergeTasteEntries(project, global), {
		confidenceFloor: runtime.config.injectionConfidenceFloor,
		maxTokens: runtime.config.maxInjectedTokens,
	});
	return runtime.tasteSnapshot;
}
