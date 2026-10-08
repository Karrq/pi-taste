import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { setTasteEnabled } from "../config.js";
import { runTasteConsolidation } from "../consolidate.js";
import { exportTasteMarkdown } from "../export.js";
import { foldLedger, normalizeTasteContent, type TasteEntry } from "../ledger/index.js";
import { appendLedger } from "../ledger/store.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "../ledger/paths.js";
import { readLedger } from "../ledger/store.js";
import { runTastePrune } from "../prune.js";
import { aggregateAcrossProjects, buildGlobalEntry } from "../reconcile.js";
import { runTasteReflect } from "../reflect.js";
import { rememberPreference } from "../remember.js";
import { mergeTasteEntries, renderTasteSection } from "../render/taste-section.js";
import type { Runtime } from "../runtime.js";
import { refreshTasteSnapshot } from "../taste-snapshot.js";

const HELP = [
	"taste: status | enable [--user] | disable [--user] | view | consolidate | prune",
	"       remember <text> | forget <text|id> | promote <text|id> | export",
].join("\n");

function parseArgs(args: string): { parts: string[]; user: boolean } {
	const all = args.trim().split(/\s+/u).filter(Boolean);
	const user = all.includes("--user");
	return { parts: all.filter((part) => part !== "--user"), user };
}

function projectEntries(cwd: string): TasteEntry[] {
	return foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries;
}

function globalEntries(): TasteEntry[] {
	return foldLedger(readLedger(ledgerPath(globalTasteDir()))).activeEntries;
}

/** Resolve an entry by full id, id prefix, or normalized content match. */
function findEntry(entries: readonly TasteEntry[], selector: string): TasteEntry | undefined {
	const needle = normalizeTasteContent(selector);
	if (!needle) return undefined;
	return (
		entries.find((entry) => entry.id === selector)
		?? entries.find((entry) => selector.length >= 6 && entry.id.startsWith(selector))
		?? entries.find((entry) => normalizeTasteContent(entry.content) === needle)
		?? entries.find((entry) => normalizeTasteContent(entry.content).includes(needle))
	);
}

function commandSessionId(ctx: ExtensionCommandContext): string | undefined {
	const manager = ctx.sessionManager as { getSessionId?: () => string | undefined } | undefined;
	try {
		return manager?.getSessionId?.();
	} catch {
		return undefined;
	}
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
		`prune: inferred entries below ${runtime.config.pruneConfidenceFloor}`,
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
		description: "Taste: status, enable/disable, view, consolidate, prune, remember, forget, promote, export",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			runtime.ensureConfig(ctx.cwd);
			const { parts, user } = parseArgs(args);
			const sub = parts[0] ?? "status";
			const selector = parts.slice(1).join(" ").trim();

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
				case "remember": {
					if (!selector) {
						ctx.ui.notify("taste: remember <text>", "warning");
						return;
					}
					const sessionId = commandSessionId(ctx);
					rememberPreference({
						cwd: ctx.cwd,
						text: selector,
						promoteAtProjectCount: runtime.config.promoteAtProjectCount,
						...(sessionId ? { sessionId } : {}),
					});
					ctx.ui.notify(`taste: recorded "${selector}" (100%, explicit)`, "info");
					return;
				}
				case "forget": {
					const entry = findEntry(projectEntries(ctx.cwd), selector) ?? findEntry(globalEntries(), selector);
					if (!entry) {
						ctx.ui.notify(`taste: no entry matching "${selector}"`, "warning");
						return;
					}
					const path = ledgerPath(entry.scope === "global" ? globalTasteDir() : projectTasteDir(ctx.cwd));
					appendLedger(path, [
						{ type: "entry.retracted", at: new Date().toISOString(), entryId: entry.id, reason: "forgotten by user" },
					]);
					ctx.ui.notify(`taste: forgot "${entry.content}"`, "info");
					return;
				}
				case "promote": {
					const entry = findEntry(projectEntries(ctx.cwd), selector) ?? findEntry(globalEntries(), selector);
					if (!entry) {
						ctx.ui.notify(`taste: no entry matching "${selector}"`, "warning");
						return;
					}
					const aggregate = aggregateAcrossProjects(entry.id);
					const projectKeys = [...aggregate.projectKeys, ...entry.projectKeys];
					const globalPath = ledgerPath(globalTasteDir());
					const existing = foldLedger(readLedger(globalPath)).entriesById.get(entry.id);
					const at = new Date().toISOString();
					appendLedger(globalPath, [
						{
							type: "entry.upserted",
							at,
							entry: buildGlobalEntry({
								entry,
								projectKeys,
								confidence: Math.max(entry.confidence, aggregate.confidence),
								now: at,
								...(existing ? { existing } : {}),
							}),
						},
					]);
					ctx.ui.notify(`taste: promoted "${entry.content}" to global`, "info");
					return;
				}
				case "export": {
					const result = exportTasteMarkdown(ctx.cwd);
					ctx.ui.notify(
						`taste: wrote ${result.projectPath} (${result.projectCount}) and ${result.globalPath} (${result.globalCount})`,
						"info",
					);
					return;
				}
				case "prune": {
					let merged = 0;
					let absorbed = 0;
					let reflectNote = "";
					try {
						const reflected = await runTasteReflect(runtime, {
							cwd: ctx.cwd,
							model: ctx.model,
							modelRegistry: ctx.modelRegistry,
							thinkingLevel: ctx.thinkingLevel,
						});
						merged = reflected.merged;
						absorbed = reflected.entriesRetracted;
						if (reflected.truncated) reflectNote = ` (reflected newest ${reflected.entriesConsidered})`;
					} catch (error) {
						reflectNote = ` (reflect unavailable: ${runtime.recordStageError("reflect", error)})`;
					}
					try {
						const result = await runTastePrune(runtime, { cwd: ctx.cwd, modelRegistry: ctx.modelRegistry });
						const classifierNote = result.classifierError ? ` (classifier unavailable: ${result.classifierError})` : "";
						ctx.ui.notify(
							`taste: merged ${merged} (${absorbed} absorbed), `
							+ `retracted ${result.retractions.length} of ${result.total} entries${reflectNote}${classifierNote}`,
							"info",
						);
					} catch (error) {
						ctx.ui.notify(`taste: prune failed: ${runtime.recordStageError("prune", error)}`, "warning");
					}
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
							`taste: ${summary.signalsRecorded} signal${summary.signalsRecorded === 1 ? "" : "s"}, `
							+ `${summary.entriesUpserted} entr${summary.entriesUpserted === 1 ? "y" : "ies"}, `
							+ `${summary.entriesRetracted} retracted from ${summary.chunks} chunk${summary.chunks === 1 ? "" : "s"}${remainder}`,
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
