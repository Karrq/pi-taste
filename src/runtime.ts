import { type Config, DEFAULTS, loadConfig } from "./config.js";

/** One line per pipeline stage failure, surfaced by `/taste status`. */
export interface StageErrors {
	extract?: string;
	distill?: string;
	reflect?: string;
	reconcile?: string;
	prune?: string;
}

export class Runtime {
	config: Config = { ...DEFAULTS, classifier: { ...DEFAULTS.classifier } };
	configLoaded = false;
	/** True while a `/taste consolidate` run is in flight. */
	runInFlight = false;
	/** Current pipeline phase, for the command spinner. */
	phase: string | undefined;
	/** Rendered `<taste>` snapshot, frozen between compactions. */
	tasteSnapshot: string | undefined;
	/** Set whenever a run finishes, so the next run can report what failed. */
	stageErrors: StageErrors = {};

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	/** Force the next `ensureConfig` to re-read settings (after `/taste enable`). */
	reloadConfig(): void {
		this.configLoaded = false;
	}

	recordStageError(stage: keyof StageErrors, error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		this.stageErrors[stage] = message;
		return message;
	}

	clearStageErrors(): void {
		this.stageErrors = {};
	}
}
