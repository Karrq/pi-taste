import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Container, Loader, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { DEFAULT_CATEGORIES, resolveModelString, setTasteEnabled, type ConfiguredModel } from "../config.js";
import { newOpId } from "../ids.js";
import { undoLastOps } from "../undo.js";
import { runTasteConsolidation, type ConsolidationProgress } from "../consolidate.js";
import { exportTasteMarkdown } from "../export.js";
import { foldLedger, type TasteEntry, type TasteScope } from "../ledger/index.js";
import { normalizeTasteContent } from "../ledger/types.js";
import { appendLedger } from "../ledger/store.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "../ledger/paths.js";
import { readLedger } from "../ledger/store.js";
import { runTastePrune } from "../prune.js";
import { aggregateAcrossProjects, buildGlobalEntry } from "../reconcile.js";
import { runTasteReflect } from "../reflect.js";
import { rememberPreference } from "../remember.js";
import { findEntry } from "../select.js";
import { TASTE_COVERAGE_RESET, planCoverageUndo } from "../session/coverage.js";
import type { SessionEntry } from "../session/types.js";
import { mergeTasteEntries, renderTasteSection } from "../render/taste-section.js";
import type { Runtime } from "../runtime.js";
import { syncTasteSnapshot } from "../taste-snapshot.js";

interface TasteSubcommand {
	name: string;
	usage: string;
	description: string;
}

const SUBCOMMANDS: TasteSubcommand[] = [
	{ name: "status", usage: "status", description: "Enabled state, entry counts, classifier mode" },
	{ name: "model", usage: "model [<provider/id[:thinking]> | reset]", description: "Override the worker model for this session" },
	{ name: "enable", usage: "enable [--project]", description: "Turn taste on and refresh the snapshot" },
	{ name: "disable", usage: "disable [--project]", description: "Turn taste off; nothing is injected" },
	{ name: "view", usage: "view", description: "List merged project and global entries" },
	{ name: "consolidate", usage: "consolidate", description: "Extract, distill, reconcile, prune on this branch" },
	{ name: "prune", usage: "prune [--global]", description: "Merge related entries, retract contradictions" },
	{ name: "remember", usage: "remember <text>", description: "Record a preference explicitly at full confidence" },
	{ name: "category", usage: "category <text | id:...> <category>", description: "Reassign an entry's category" },
	{ name: "forget", usage: "forget <text | id:...>", description: "Retract one entry by text or id" },
	{ name: "undo", usage: "undo [n] [--dry]", description: "Remove the last n operations (default 1) from the ledger" },
	{ name: "promote", usage: "promote <text | id:...>", description: "Force an entry into the global layer" },
	{ name: "export", usage: "export", description: "Write ./taste.md with the merged view" },
	{ name: "help", usage: "help", description: "Show this command list" },
];

function helpText(): string {
	const width = Math.max(...SUBCOMMANDS.map((sub) => sub.usage.length));
	const lines = SUBCOMMANDS.map((sub) => `  ${sub.usage.padEnd(width)}  ${sub.description}`);
	return ["taste: usage", ...lines].join("\n");
}

function subcommandCompletions(argumentPrefix: string) {
	const prefix = argumentPrefix.trimStart();
	// Only complete the first token; leave later arguments (text, id:...) alone.
	if (prefix.includes(" ")) return null;
	const query = prefix.toLowerCase();
	const matches = SUBCOMMANDS.filter((sub) => sub.name.startsWith(query));
	if (matches.length === 0) return null;
	return matches.map((sub) => ({ value: sub.name, label: sub.name, description: sub.description }));
}

function parseArgs(args: string): { parts: string[]; project: boolean; global: boolean; dry: boolean } {
	const all = args.trim().split(/\s+/u).filter(Boolean);
	const project = all.includes("--project");
	const global = all.includes("--global");
	const dry = all.includes("--dry");
	return {
		parts: all.filter((part) => part !== "--project" && part !== "--global" && part !== "--dry"),
		project,
		global,
		dry,
	};
}

/**
 * Editor-area takeover shown while an explicit `/taste consolidate` runs. It is
 * mounted through `ctx.ui.custom`, which clears the editor and restores it when
 * the command finishes, mirroring the loader `/share` uses.
 */
class ConsolidationLoader extends Container {
	private readonly loader: Loader;
	private cancelling = false;

	constructor(tui: TUI, theme: Theme, message: string, private readonly onCancel: () => void) {
		const border = (text: string) => theme.fg("accent", text);
		super();
		this.addChild(new DynamicBorder(border));
		this.loader = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), message);
		this.addChild(this.loader);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `${keyText("tui.select.cancel")} cancel`), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(border));
	}

	setMessage(message: string): void {
		this.loader.setMessage(message);
	}

	handleInput(data: string): void {
		if (this.cancelling) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.cancelling = true;
			this.loader.setMessage("taste: cancelling…");
			this.onCancel();
		}
	}

	dispose(): void {
		this.loader.stop();
	}
}

function plural(count: number, singular: string, pluralForm: string): string {
	return count === 1 ? singular : pluralForm;
}

function formatConfiguredModel(model: ConfiguredModel): string {
	return `${model.provider}/${model.id}${model.thinking ? `:${model.thinking}` : ""}`;
}

function progressMessage(progress: ConsolidationProgress): string {
	const signals = `${progress.signals} ${plural(progress.signals, "signal", "signals")}`;
	const entries = `${progress.entries} ${plural(progress.entries, "entry", "entries")}`;
	if (progress.stage === "prune") {
		return `taste: merging and pruning — ${signals}, ${entries}`;
	}
	return `taste: extracting chunk ${progress.chunk} of ${progress.maxChunks} — ${signals}, ${entries}`;
}

function projectEntries(cwd: string): TasteEntry[] {
	return foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries;
}

function globalEntries(): TasteEntry[] {
	return foldLedger(readLedger(ledgerPath(globalTasteDir()))).activeEntries;
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
	const worker = runtime.modelOverride
		? `override ${formatConfiguredModel(runtime.modelOverride)}`
		: "session model (modelMap applies)";
	return [
		`taste: ${runtime.config.enabled ? "enabled" : "disabled"}`,
		`project: ${project.length} entries — ${projectTasteDir(cwd)}`,
		`global: ${global.length} entries — ${globalTasteDir()}`,
		`injectable: ${eligible.length} (floor ${runtime.config.injectionConfidenceFloor})`,
		`prune: inferred entries below ${runtime.config.pruneConfidenceFloor}`,
		`classifier: ${classifier.mode} via ${classifier.provider}${classifier.model ? `/${classifier.model}` : ""}`,
		`worker model: ${worker}`,
	].join("\n");
}

function formatEntryLine(entry: TasteEntry): string {
	return `id:${entry.id} ${Math.round(entry.confidence * 100)}% [${entry.category}] ${entry.content}`;
}

function entrySection(label: string, entries: readonly TasteEntry[], total: number, note?: string): string {
	const sorted = [...entries].sort(
		(a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt),
	);
	const lines = sorted.map(formatEntryLine);
	if (note) lines.push(note);
	return `${label} (${total})\n${lines.join("\n")}`;
}

function viewText(runtime: Runtime, cwd: string): string {
	void runtime;
	const project = projectEntries(cwd);
	const global = globalEntries();
	if (project.length === 0 && global.length === 0) return "taste: no entries yet";

	// A project entry whose content is also in the global layer is the same
	// preference; the global row already shows it, so hide the duplicate but count it.
	const globalKeys = new Set(global.map((entry) => normalizeTasteContent(entry.content)));
	const visibleProject = project.filter((entry) => !globalKeys.has(normalizeTasteContent(entry.content)));
	const hidden = project.length - visibleProject.length;

	const sections: string[] = [];
	if (project.length > 0) {
		const note = hidden > 0
			? `  \u2026 ${hidden} more ${hidden === 1 ? "entry" : "entries"} also promoted to global`
			: undefined;
		sections.push(entrySection("project", visibleProject, project.length, note));
	}
	if (global.length > 0) sections.push(entrySection("global", global, global.length));
	return sections.join("\n\n");
}

export function registerTasteCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("taste", {
		description: `Taste: ${SUBCOMMANDS.filter((sub) => sub.name !== "help").map((sub) => sub.name).join(", ")}`,
		getArgumentCompletions: subcommandCompletions,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			runtime.ensureConfig(ctx.cwd);
			const { parts, project, global, dry } = parseArgs(args);
			const sub = parts[0] ?? "status";
			const selector = parts.slice(1).join(" ").trim();

			switch (sub) {
				case "enable":
				case "disable": {
					const enabled = sub === "enable";
					setTasteEnabled({ cwd: ctx.cwd, enabled, scope: project ? "project" : "user" });
					runtime.reloadConfig();
					runtime.ensureConfig(ctx.cwd);
					// The snapshot entry records the state. Only notify when no entry was
					// written, so the command is never a silent no-op.
					const result = syncTasteSnapshot(pi, runtime, ctx.cwd);
					if (!result.changed && !result.section) {
						ctx.ui.notify(`taste: ${enabled ? "enabled" : "disabled"}`, "info");
					}
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
						opId: newOpId(),
					});
					ctx.ui.notify(`taste: recorded "${selector}" (100%, explicit)`, "info");
					return;
				}
				case "category": {
					// The category is the trailing token, so the selector may contain
					// spaces; category names never do.
					const parsed = parseCategoryArgs(parts.slice(1), Object.keys(runtime.config.categories));
					if ("error" in parsed) {
						ctx.ui.notify(parsed.error, "warning");
						return;
					}
					const { target, category } = parsed;
					const entry = findEntry(projectEntries(ctx.cwd), target) ?? findEntry(globalEntries(), target);
					if (!entry) {
						ctx.ui.notify(`taste: no entry matching "${target}"`, "warning");
						return;
					}
					if (entry.category === category) {
						ctx.ui.notify(`taste: "${entry.content}" is already ${category}`, "info");
						return;
					}
					// Category is not part of the content-hash id, so this is a plain
					// last-write-wins upsert that keeps provenance and confidence.
					const at = new Date().toISOString();
					const path = ledgerPath(entry.scope === "global" ? globalTasteDir() : projectTasteDir(ctx.cwd));
					appendLedger(path, [
						{ type: "entry.upserted", at, entry: { ...entry, category, updatedAt: at }, opId: newOpId() },
					]);
					ctx.ui.notify(`taste: "${entry.content}" → ${category}`, "info");
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
						{
							type: "entry.retracted",
							at: new Date().toISOString(),
							entryId: entry.id,
							reason: "forgotten by user",
							opId: newOpId(),
						},
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
							opId: newOpId(),
						},
					]);
					ctx.ui.notify(`taste: promoted "${entry.content}" to global`, "info");
					return;
				}
				case "export": {
					const result = exportTasteMarkdown(ctx.cwd);
					ctx.ui.notify(
						`taste: wrote ${result.path} (${result.projectCount} project, ${result.globalCount} global)`,
						"info",
					);
					return;
				}
				case "prune": {
					const opId = newOpId();
					const scopes: TasteScope[] = global ? ["project", "global"] : ["project"];
					let merged = 0;
					let absorbed = 0;
					let retracted = 0;
					let total = 0;
					const notes: string[] = [];
					for (const scope of scopes) {
						try {
							const reflected = await runTasteReflect(runtime, {
								cwd: ctx.cwd,
								model: ctx.model,
								modelRegistry: ctx.modelRegistry,
								thinkingLevel: ctx.thinkingLevel,
								opId,
								scope,
							});
							merged += reflected.merged;
							absorbed += reflected.entriesRetracted;
							if (reflected.truncated) notes.push(`${scope}: reflected newest ${reflected.entriesConsidered}`);
						} catch (error) {
							notes.push(`${scope}: reflect unavailable (${runtime.recordStageError("reflect", error)})`);
						}
						try {
							const result = await runTastePrune(runtime, {
								cwd: ctx.cwd,
								modelRegistry: ctx.modelRegistry,
								opId,
								scope,
							});
							retracted += result.retractions.length;
							total += result.total;
							if (result.classifierError) notes.push(`${scope}: classifier unavailable (${result.classifierError})`);
						} catch (error) {
							ctx.ui.notify(`taste: ${scope} prune failed: ${runtime.recordStageError("prune", error)}`, "warning");
							return;
						}
					}
					const scopeLabel = global ? " (project + global)" : "";
					const note = notes.length > 0 ? ` [${notes.join("; ")}]` : "";
					ctx.ui.notify(
						`taste: merged ${merged} (${absorbed} absorbed), `
						+ `retracted ${retracted} of ${total} entries${scopeLabel}${note}`,
						"info",
					);
					return;
				}
				case "consolidate": {
					if (runtime.runInFlight) {
						ctx.ui.notify("taste: consolidation already running", "warning");
						return;
					}
					runtime.runInFlight = true;
					runtime.clearStageErrors();
					// Take over the editor only in the TUI and only for this explicit run;
					// RPC/print keep the notify-only path.
					let loader: ConsolidationLoader | undefined;
					let closeLoader: (() => void) | undefined;
					let loaderDone: Promise<void> | undefined;
					const controller = ctx.mode === "tui" ? new AbortController() : undefined;
					try {
						if (ctx.mode === "tui" && controller) {
							loaderDone = ctx.ui.custom<void>((tui, theme, _kb, done) => {
								closeLoader = () => done(undefined);
								const created = new ConsolidationLoader(tui, theme, "taste: consolidating…", () => controller.abort());
								loader = created;
								return created;
							});
						}
						const summary = await runTasteConsolidation(pi, runtime, {
							cwd: ctx.cwd,
							hasUI: ctx.hasUI,
							ui: ctx.ui,
							model: ctx.model,
							modelRegistry: ctx.modelRegistry,
							thinkingLevel: ctx.thinkingLevel,
							sessionManager: ctx.sessionManager,
							opId: newOpId(),
							onProgress: (progress) => loader?.setMessage(progressMessage(progress)),
							...(controller ? { signal: controller.signal } : {}),
						});
						if (summary.cancelled) {
							ctx.ui.notify(
								`taste: cancelled — ${summary.signalsRecorded} signal${summary.signalsRecorded === 1 ? "" : "s"}, `
								+ `${summary.entriesUpserted} entr${summary.entriesUpserted === 1 ? "y" : "ies"} kept; `
								+ "the in-flight chunk was not committed",
								"warning",
							);
						} else {
							// Explicit consolidation writes the ledger but deliberately does not
							// refresh the injected snapshot; that happens at the next compaction.
							const remainder = summary.reachedEnd ? "" : " (more remain; run again)";
							ctx.ui.notify(
								`taste: ${summary.signalsRecorded} signal${summary.signalsRecorded === 1 ? "" : "s"}, `
								+ `${summary.entriesUpserted} entr${summary.entriesUpserted === 1 ? "y" : "ies"}, `
								+ `${summary.entriesRetracted} retracted from ${summary.chunks} chunk${summary.chunks === 1 ? "" : "s"}${remainder}`,
								"info",
							);
						}
					} catch (error) {
						const message = runtime.recordStageError("extract", error);
						ctx.ui.notify(`taste: consolidation failed: ${message}`, "warning");
					} finally {
						loader?.dispose();
						closeLoader?.();
						await loaderDone?.catch(() => {});
						runtime.runInFlight = false;
					}
					return;
				}
				case "undo": {
					const count = selector ? Number.parseInt(selector, 10) : 1;
					if (!Number.isFinite(count) || count < 1) {
						ctx.ui.notify("taste: undo [n] [--dry]", "warning");
						return;
					}
					const result = undoLastOps(ctx.cwd, count, { dryRun: dry });
					if (!result.changed) {
						ctx.ui.notify("taste: nothing to undo", "info");
						return;
					}
					// Coverage lives in session entries, which cannot be deleted, so a run
					// that extracted is rewound by appending a reset marker.
					const branch = ctx.sessionManager.getBranch() as SessionEntry[];
					const coverage = planCoverageUndo(branch, result.opIds);
					const coverageNote = coverage
						? `, rewound coverage over ${coverage.removed} chunk${coverage.removed === 1 ? "" : "s"}`
						: "";
					const opLabel = `${result.opIds.length} ${plural(result.opIds.length, "operation", "operations")}`;
					const recordLabel = `${result.recordsRemoved} ${plural(result.recordsRemoved, "record", "records")}`;

					if (dry) {
						const lines = result.records.flatMap((record) => {
							const head = `  ${record.file} - ${record.summary}`;
							const restored = (record.sources ?? []).map((source) => `      + [${source.category}] ${source.content}`);
							return [head, ...restored];
						});
						if (coverage) {
							const target = coverage.coversUpToId ? `to ${coverage.coversUpToId}` : "(clear coverage)";
							lines.push(`  coverage: rewind ${coverage.removed} chunk${coverage.removed === 1 ? "" : "s"} ${target}`);
						}
						ctx.ui.notify(
							`taste: dry run \u2014 would remove ${opLabel} (${recordLabel})\n${lines.join("\n")}`,
							"info",
						);
						return;
					}

					if (coverage) {
						pi.appendEntry(
							TASTE_COVERAGE_RESET,
							coverage.coversUpToId ? { coversUpToId: coverage.coversUpToId } : {},
						);
					}
					syncTasteSnapshot(pi, runtime, ctx.cwd);
					ctx.ui.notify(
						`taste: undid ${opLabel} (${recordLabel} removed${coverageNote})`,
						"info",
					);
					return;
				}
				case "status": {
					ctx.ui.notify(statusText(runtime, ctx.cwd), "info");
					return;
				}
				case "model": {
					const spec = selector.trim();
					const registry = ctx.modelRegistry as { find?: (provider: string, id: string) => unknown } | undefined;
					if (!spec || spec === "status" || spec === "show") {
						const current = runtime.modelOverride
							? `session override ${formatConfiguredModel(runtime.modelOverride)}`
							: "session model (modelMap applies)";
						ctx.ui.notify(`taste: worker model \u2014 ${current}`, "info");
						return;
					}
					if (spec === "reset" || spec === "clear" || spec === "default" || spec === "session") {
						runtime.modelOverride = undefined;
						ctx.ui.notify("taste: session model override cleared", "info");
						return;
					}
					const parsed = resolveModelString(spec, {});
					if (!parsed) {
						ctx.ui.notify("taste: model <provider/id[:thinking]> | reset", "warning");
						return;
					}
					runtime.modelOverride = parsed;
					const found = registry?.find?.(parsed.provider, parsed.id);
					ctx.ui.notify(
						`taste: session model \u2192 ${formatConfiguredModel(parsed)}${found ? "" : " (not in registry; will fall back)"}`,
						found ? "info" : "warning",
					);
					return;
				}
				case "help":
				default: {
					ctx.ui.notify(helpText(), "info");
				}
			}
		},
	});
}

/** Exposed for tests: parse `<text | id:...> <category>` into a target and a validated category. */
export function parseCategoryArgs(
	rest: readonly string[],
	known: readonly string[] = Object.keys(DEFAULT_CATEGORIES),
): { target: string; category: string } | { error: string } {
	const vocabulary = [...new Set(known)];
	if (rest.length < 2) {
		return { error: `taste: category <text | id:...> <category>\ncategories: ${vocabulary.join(", ")}` };
	}
	const category = rest[rest.length - 1] as string;
	const target = rest.slice(0, -1).join(" ").trim();
	if (!vocabulary.includes(category)) {
		return { error: `taste: unknown category "${category}"\ncategories: ${vocabulary.join(", ")}` };
	}
	return { target, category };
}

/** Exposed for tests: the exact injected section for the current ledgers. */
export function previewSection(runtime: Runtime, cwd: string): string | undefined {
	return renderTasteSection(mergeTasteEntries(projectEntries(cwd), globalEntries()), {
		confidenceFloor: runtime.config.injectionConfidenceFloor,
		maxTokens: runtime.config.maxInjectedTokens,
	});
}

/** Exposed for tests: subcommand autocomplete candidates for a slash-command prefix. */
export { helpText, subcommandCompletions };

/** Exposed for tests: the editor-area loader and its progress text. */
export { ConsolidationLoader, progressMessage };

/** Exposed for tests: the `/taste view` rendering and category argument parsing. */
export { formatEntryLine, viewText };
