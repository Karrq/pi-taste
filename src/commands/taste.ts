import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { setTasteEnabled } from "../config.js";
import { runTasteConsolidation } from "../consolidate.js";
import { foldLedger } from "../ledger/fold.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "../ledger/paths.js";
import { readLedger } from "../ledger/store.js";
import { mergeTasteEntries, renderTasteSection } from "../render/taste-section.js";
import type { Runtime } from "../runtime.js";
import { refreshTasteSnapshot } from "../taste-snapshot.js";

const HELP = [
	"taste: status | enable [--user] | disable [--user] | view | consolidate",
].join("\n");

function parseArgs(args: string): { parts: string[]; user: boolean } {
	const all = args.trim().split(/\s+/u).filter(Boolean);
	const user = all.includes("--user");
	return { parts: all.filter((part) => part !== "--user"), user };
}

function projectEntries(cwd: string) {
	return foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries;
}

function globalEntries() {
	return foldLedger(readLedger(ledgerPath(globalTasteDir()))).activeEntries;
}

function statusText(runtime: Runtime, cwd: string): string {
	const project = projectEntries(cwd);
	const global = globalEntries();
	const eligible = mergeTasteEntries(project, global).filter(
		(entry) => entry.confidence >= runtime.config.injectionConfidenceFloor,
	);
	const { classifier } = runtime.config;
	return [
		`taste: ${runtime.config.enabled ? "enabled" : "disabled"}`,
		`project: ${project.length} entries — ${projectTasteDir(cwd)}`,
		`global: ${global.length} entries — ${globalTasteDir()}`,
		`injectable: ${eligible.length} (floor ${runtime.config.injectionConfidenceFloor})`,
		`classifier: ${classifier.mode} via ${classifier.provider}${classifier.model ? `/${classifier.model}` : ""}`,
	].join("\n");
}

function viewText(runtime: Runtime, cwd: string): string {
	const merged = mergeTasteEntries(projectEntries(cwd), globalEntries()).sort(
		(a, b) => b.confidence - a.confidence,
	);
	if (merged.length === 0) return "taste: no entries yet";
	return merged
		.map((entry) => `${Math.round(entry.confidence * 100)}% [${entry.category}] ${entry.content}`)
		.join("\n");
}

export function registerTasteCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("taste", {
		description: "Taste: status, enable/disable, view, consolidate",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			runtime.ensureConfig(ctx.cwd);
			const { parts, user } = parseArgs(args);
			const sub = parts[0] ?? "status";

			switch (sub) {
				case "enable":
				case "disable": {
					const enabled = sub === "enable";
					const path = setTasteEnabled({ cwd: ctx.cwd, enabled, user });
					runtime.reloadConfig();
					runtime.ensureConfig(ctx.cwd);
					refreshTasteSnapshot(runtime, ctx.cwd);
					ctx.ui.notify(`taste: ${enabled ? "enabled" : "disabled"} (${path})`, "info");
					return;
				}
				case "view": {
					ctx.ui.notify(viewText(runtime, ctx.cwd), "info");
					return;
				}
				case "consolidate": {
					if (runtime.runInFlight) {
						ctx.ui.notify("taste: consolidation already running", "warning");
						return;
					}
					runtime.runInFlight = true;
					runtime.clearStageErrors();
					try {
						const summary = await runTasteConsolidation(pi, runtime, {
							cwd: ctx.cwd,
							hasUI: ctx.hasUI,
							ui: ctx.ui,
							model: ctx.model,
							modelRegistry: ctx.modelRegistry,
							thinkingLevel: ctx.thinkingLevel,
							sessionManager: ctx.sessionManager,
						});
						// Explicit consolidation writes the ledger but deliberately does not
						// refresh the injected snapshot; that happens at the next compaction.
						const remainder = summary.reachedEnd ? "" : " (more remain; run again)";
						ctx.ui.notify(
							`taste: ${summary.signalsRecorded} signal${summary.signalsRecorded === 1 ? "" : "s"} from ${summary.chunks} chunk${summary.chunks === 1 ? "" : "s"}${remainder}`,
							"info",
						);
					} catch (error) {
						const message = runtime.recordStageError("extract", error);
						ctx.ui.notify(`taste: consolidation failed: ${message}`, "warning");
					} finally {
						runtime.runInFlight = false;
					}
					return;
				}
				case "status": {
					ctx.ui.notify(statusText(runtime, ctx.cwd), "info");
					return;
				}
				default: {
					ctx.ui.notify(HELP, "info");
				}
			}
		},
	});
}

/** Exposed for tests: the exact injected section for the current ledgers. */
export function previewSection(runtime: Runtime, cwd: string): string | undefined {
	return renderTasteSection(mergeTasteEntries(projectEntries(cwd), globalEntries()), {
		confidenceFloor: runtime.config.injectionConfidenceFloor,
		maxTokens: runtime.config.maxInjectedTokens,
	});
}
