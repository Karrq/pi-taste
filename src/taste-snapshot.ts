import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, MouseRegion, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { foldLedger } from "./ledger/fold.js";
import { globalTasteDir, ledgerPath, projectTasteDir } from "./ledger/paths.js";
import { readLedger } from "./ledger/store.js";
import { mergeTasteEntries, renderTasteSection } from "./render/taste-section.js";
import type { Runtime } from "./runtime.js";

/** Session custom entry recording the injected `<taste>` block. */
export const TASTE_SNAPSHOT_ENTRY = "taste.snapshot";

export interface TasteSnapshotEntryData {
	/** Detail line shown under the title. */
	summary: string;
	/** The full injected block, shown when the card is expanded. */
	block?: string;
	/** Whether taste was enabled when this entry was written. */
	enabled: boolean;
	projectCount: number;
	globalCount: number;
}

export interface TasteSnapshotResult {
	/** The injected block, or undefined when nothing clears the floor. */
	section: string | undefined;
	projectCount: number;
	globalCount: number;
	/** True when the injected text differs from the previous snapshot. */
	changed: boolean;
}

function plural(count: number, singular: string, pluralForm: string): string {
	return count === 1 ? singular : pluralForm;
}

/**
 * Recompute the injected `<taste>` snapshot from the project and global ledgers.
 *
 * Callers are deliberately few: session start, after a compaction, and an
 * explicit `/taste enable`/`/taste undo`. Ordinary turns must not call this,
 * because changing the injected text invalidates the provider's cached prefix.
 * `/taste consolidate` writes the ledger but does not refresh the snapshot; the
 * effect appears at the next compaction.
 */
export function refreshTasteSnapshot(runtime: Runtime, cwd: string): TasteSnapshotResult {
	runtime.ensureConfig(cwd);
	const previous = runtime.tasteSnapshot;
	if (!runtime.config.enabled) {
		runtime.tasteSnapshot = undefined;
		return { section: undefined, projectCount: 0, globalCount: 0, changed: previous !== undefined };
	}
	const project = foldLedger(readLedger(ledgerPath(projectTasteDir(cwd)))).activeEntries;
	const global = foldLedger(readLedger(ledgerPath(globalTasteDir()))).activeEntries;
	const section = renderTasteSection(mergeTasteEntries(project, global), {
		confidenceFloor: runtime.config.injectionConfidenceFloor,
		maxTokens: runtime.config.maxInjectedTokens,
	});
	runtime.tasteSnapshot = section;
	return {
		section,
		projectCount: project.length,
		globalCount: global.length,
		changed: section !== previous,
	};
}

/**
 * Refresh the snapshot and, when the injected text changed, append a debug entry
 * showing what was loaded. A disable transition also appends, marked as such,
 * so the transcript records that nothing is being injected. The entry never
 * reaches the LLM context; it exists so the transcript records when and why the
 * injected block changed.
 *
 * Returns the refresh result so callers can tell whether an entry was written.
 */
export function syncTasteSnapshot(pi: ExtensionAPI, runtime: Runtime, cwd: string): TasteSnapshotResult {
	const result = refreshTasteSnapshot(runtime, cwd);
	if (!result.changed) return result;
	const enabled = runtime.config.enabled;
	const summary = enabled
		? `loaded ${result.projectCount} project ${plural(result.projectCount, "preference", "preferences")} and ${result.globalCount} global ${plural(result.globalCount, "preference", "preferences")}`
		: "disabled";
	pi.appendEntry<TasteSnapshotEntryData>(TASTE_SNAPSHOT_ENTRY, {
		summary,
		enabled,
		projectCount: result.projectCount,
		globalCount: result.globalCount,
		...(enabled && result.section ? { block: result.section } : {}),
	});
	return result;
}

/**
 * Card for the snapshot entry. Bold `taste` title, the detail line below, and the
 * full block when expanded. Left-clicking toggles expansion, mirroring how tool
 * output behaves, so it works in fullscreen mode without the global keybinding.
 */
export class TasteSnapshotCard extends Container {
	private readonly body = new Container();
	private expanded: boolean;

	constructor(
		private readonly data: TasteSnapshotEntryData | undefined,
		private readonly theme: Theme,
		expanded: boolean,
	) {
		super();
		this.expanded = expanded;
		this.draw();
		this.addChild(new MouseRegion(this.body, (event) => this.onMouse(event)));
	}

	private onMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.expanded = !this.expanded;
		this.draw();
		return { handled: true };
	}

	private draw(): void {
		this.body.clear();
		const box = new Box(1, 1, (text) => this.theme.bg("customMessageBg", text));
		box.addChild(new Text(this.theme.fg("toolTitle", this.theme.bold("taste")), 0, 0));
		box.addChild(new Text(this.theme.fg("dim", this.data?.summary ?? "snapshot"), 0, 0));
		if (this.expanded) {
			const lines = this.data?.block
				? this.data.block.split("\n")
				: [this.data && !this.data.enabled
					? "(taste disabled: nothing injected)"
					: "(nothing injected: no entries above the confidence floor)"];
			for (const line of lines) box.addChild(new Text(this.theme.fg("toolOutput", line), 0, 0));
		}
		this.body.addChild(box);
	}
}

/** Render the snapshot entry as a click-expandable card. */
export function registerTasteSnapshotRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<TasteSnapshotEntryData>(TASTE_SNAPSHOT_ENTRY, (entry, { expanded }, theme: Theme) => {
		return new TasteSnapshotCard(entry.data, theme, expanded);
	});
}
