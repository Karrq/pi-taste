import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/** Pipeline stages that resolve a worker model, and so can be routed by `modelMap`. */
export const WORKER_STAGES = ["extract", "reflect"] as const;
export type WorkerStage = (typeof WORKER_STAGES)[number];

/**
 * Glob-matched routing for a stage's model. `match` tests the active session
 * model's `"<provider>/<id>"`; the first matching entry wins. `model` is
 * `"<provider>/<id>[:<thinking>]"` with `$provider`, `$id`, `$model`, and
 * `$thinking` substitutions from the session model.
 */
export interface ModelMapEntry {
	match: string;
	stages?: WorkerStage[];
	model: string;
}

export const SYSTEM_ONE_MODES = ["off", "shadow", "primary"] as const;
export type SystemOneMode = (typeof SYSTEM_ONE_MODES)[number];

/**
 * Routes the distill (and later prune) decision to a System One classifier
 * endpoint instead of a tool-calling LLM.
 *
 * - `off`: classify with the LLM only.
 * - `shadow`: the classifier scores every candidate but the LLM decides; both
 *   verdicts are written to the calibration log.
 * - `primary`: the classifier decides.
 */
export interface ClassifierConfig {
	mode: SystemOneMode;
	/** Classifier provider registered by another extension. Defaults to pi-jev's. */
	provider: string;
	/** Classifier model id within the provider; defaults to the provider's only model. */
	model?: string;
	/** P(is_preference) must reach this for a signal to become an entry. */
	preferenceThreshold: number;
	/** Questions per request; large batches fan out against the same state. */
	maxQuestionsPerRequest: number;
	requestTimeoutMs: number;
}

export const CLASSIFIER_DEFAULTS: Readonly<ClassifierConfig> = {
	mode: "shadow",
	provider: "local-jev",
	preferenceThreshold: 0.5,
	maxQuestionsPerRequest: 250,
	requestTimeoutMs: 60_000,
};

/**
 * The category set shipped as the default. It is ordinary config: whatever
 * `taste.categories` resolves to is the complete vocabulary, and setting that
 * key replaces this default rather than extending it.
 */
export const DEFAULT_CATEGORIES: Readonly<Record<string, string>> = {
	formatting: "Whitespace, line width, quoting, and other purely stylistic conventions.",
	naming: "Identifier, file, and symbol naming conventions.",
	architecture: "Module boundaries, layering, abstraction, and code structure.",
	typescript: "TypeScript and JavaScript typing and language usage.",
	python: "Python-specific idioms and tooling.",
	testing: "Test frameworks, structure, coverage, and what to test.",
	"error-handling": "How errors, failures, and edge cases are handled.",
	tooling: "Build tools, package managers, linters, formatters, CI.",
	dependencies: "When and how to add or avoid dependencies.",
	"api-design": "Function, module, and interface signatures.",
	workflow: "How work is done: commits, branches, reviews, planning.",
	communication: "How the assistant should talk: verbosity, format, tone.",
	general: "A durable preference that fits none of the above.",
};

export interface Config {
	/**
	 * Master switch. When false nothing is injected. `/taste consolidate` and
	 * `/taste remember` still write the ledger, since those are explicit user
	 * actions.
	 */
	enabled: boolean;
	classifier: ClassifierConfig;
	/** The complete category vocabulary. Defaults to `DEFAULT_CATEGORIES`; a set value replaces it. */
	categories: Record<string, string>;
	/** Entries below this confidence are not injected. */
	injectionConfidenceFloor: number;
	/** Approximate token budget for the injected `<taste>` section. */
	maxInjectedTokens: number;
	/** Promote a preference to the global ledger once seen in this many projects. */
	promoteAtProjectCount: number;
	/** Inferred entries below this confidence are pruned; explicit entries are exempt. */
	pruneConfidenceFloor: number;
	/** Estimated token cap for one extraction chunk. Unset derives ~1/5 of the model window. */
	extractChunkMaxTokens?: number;
	/** Maximum extraction chunks one `/taste consolidate` run may process. */
	consolidateMaxChunks: number;
	/** Most recently updated entries one reflection call may consider. */
	reflectMaxEntries: number;
	agentMaxTurns: number;
	agentMaxTokens: number;
	/** Glob routing per stage. With no match the worker uses the session model. */
	modelMap: ModelMapEntry[];
	debugLog: boolean;
	/** Disable all work without touching settings. */
	passive: boolean;
}

export const DEFAULTS: Config = {
	enabled: false,
	classifier: { ...CLASSIFIER_DEFAULTS },
	categories: { ...DEFAULT_CATEGORIES },
	injectionConfidenceFloor: 0.5,
	maxInjectedTokens: 1_200,
	promoteAtProjectCount: 2,
	pruneConfidenceFloor: 0.3,
	extractChunkMaxTokens: undefined,
	consolidateMaxChunks: 8,
	reflectMaxEntries: 60,
	agentMaxTurns: 12,
	agentMaxTokens: 16_000,
	modelMap: [],
	debugLog: false,
	passive: false,
};

const SETTINGS_KEY = "taste";
const PASSIVE_ENV = "PI_TASTE_PASSIVE";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isWorkerStage(value: unknown): value is WorkerStage {
	return typeof value === "string" && (WORKER_STAGES as readonly string[]).includes(value);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function probability(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** Keep only named categories that carry a non-empty description. */
function normalizeCategoryMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [rawName, rawDescription] of Object.entries(value)) {
		const name = rawName.trim();
		const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
		if (name && description) out[name] = description;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Translate a `match` glob (`*`, `?`) into an anchored, case-insensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/** Split a selector into its glob and an optional exact trailing thinking-level predicate. */
export function parseMatchSelector(selector: string): { glob: string; thinking?: ModelThinkingLevel } {
	const lastColon = selector.lastIndexOf(":");
	if (lastColon !== -1) {
		const suffix = selector.slice(lastColon + 1);
		if (isThinkingLevel(suffix)) return { glob: selector.slice(0, lastColon), thinking: suffix };
	}
	return { glob: selector };
}

/** Resolve `"<provider>/<id>[:<thinking>]"` with `$provider`/`$id`/`$model`/`$thinking` substitution. */
export function resolveModelString(
	model: string,
	session: { provider?: string; id?: string; thinking?: ModelThinkingLevel },
): ConfiguredModel | undefined {
	let text = model.trim();
	if (!text) return undefined;
	if (session.provider !== undefined) text = text.replaceAll("$provider", session.provider);
	if (session.id !== undefined) text = text.replaceAll("$id", session.id);
	if (session.provider !== undefined && session.id !== undefined) {
		text = text.replaceAll("$model", `${session.provider}/${session.id}`);
	}
	if (session.thinking !== undefined) text = text.replaceAll("$thinking", session.thinking);
	else text = text.replace(/:\$thinking/gu, "").replace(/\$thinking/gu, "");
	if (text.includes("$provider") || text.includes("$id") || text.includes("$model") || text.includes("$thinking")) {
		return undefined;
	}
	const parsed = parseMatchSelector(text);
	const slash = parsed.glob.indexOf("/");
	if (slash <= 0 || slash === parsed.glob.length - 1) return undefined;
	const provider = parsed.glob.slice(0, slash);
	const id = parsed.glob.slice(slash + 1);
	if (!provider || !id) return undefined;
	const resolved: ConfiguredModel = { provider, id };
	if (parsed.thinking !== undefined) resolved.thinking = parsed.thinking;
	return resolved;
}

export function activeModelKey(model: unknown): string | undefined {
	if (!isRecord(model)) return undefined;
	const provider = nonEmptyString(model.provider);
	const id = nonEmptyString(model.id);
	return provider && id ? `${provider}/${id}` : undefined;
}

export function resolveConfiguredModel(
	config: Config,
	activeModel: unknown,
	stage?: WorkerStage,
	sessionThinking?: ModelThinkingLevel,
): ConfiguredModel | undefined {
	const key = activeModelKey(activeModel);
	if (key) {
		const slash = key.indexOf("/");
		const session = { provider: key.slice(0, slash), id: key.slice(slash + 1), thinking: sessionThinking };
		for (const entry of config.modelMap) {
			if (entry.stages && (!stage || !entry.stages.includes(stage))) continue;
			if (!globToRegExp(entry.match).test(key)) continue;
			const resolved = resolveModelString(entry.model, session);
			if (resolved) return resolved;
		}
	}
	return undefined;
}

function normalizeStages(value: unknown): WorkerStage[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const stages = value.filter(isWorkerStage);
	return stages.length > 0 ? [...new Set(stages)] : undefined;
}

function normalizeModelMapEntry(value: unknown): ModelMapEntry | undefined {
	if (!isRecord(value)) return undefined;
	const match = nonEmptyString(value.match);
	const model = nonEmptyString(value.model);
	// A literal `/` is the usual provider/id shape, but `$model` and `$provider`
	// supply the provider at resolve time and carry no slash of their own.
	const hasProvider = model?.includes("/") || model?.includes("$model") || model?.includes("$provider");
	if (!match || !model || !hasProvider) return undefined;
	const entry: ModelMapEntry = { match, model };
	const stages = normalizeStages(value.stages);
	// A present-but-unusable `stages` rejects the entry rather than widening it
	// to every stage, so a misspelled stage cannot silently route every worker.
	if (value.stages !== undefined && !stages) return undefined;
	if (stages) entry.stages = stages;
	return entry;
}

function normalizeModelMap(value: unknown): ModelMapEntry[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries = value.map(normalizeModelMapEntry).filter((entry): entry is ModelMapEntry => entry !== undefined);
	return entries.length > 0 ? entries : undefined;
}

/** Partial classifier block: only fields the user set, so project overrides merge field-wise. */
export function normalizeClassifierPartial(value: unknown): Partial<ClassifierConfig> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Partial<ClassifierConfig> = {};
	if (typeof value.mode === "string" && (SYSTEM_ONE_MODES as readonly string[]).includes(value.mode)) {
		out.mode = value.mode as SystemOneMode;
	}
	const provider = nonEmptyString(value.provider);
	if (provider) out.provider = provider;
	const model = nonEmptyString(value.model);
	if (model) out.model = model;
	const preferenceThreshold = probability(value.preferenceThreshold);
	if (preferenceThreshold !== undefined) out.preferenceThreshold = preferenceThreshold;
	const maxQuestionsPerRequest = positiveInteger(value.maxQuestionsPerRequest);
	if (maxQuestionsPerRequest !== undefined) out.maxQuestionsPerRequest = maxQuestionsPerRequest;
	const requestTimeoutMs = positiveInteger(value.requestTimeoutMs);
	if (requestTimeoutMs !== undefined) out.requestTimeoutMs = requestTimeoutMs;
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalized settings block, with `classifier` left partial so overrides merge field-wise. */
export interface NormalizedSettings extends Omit<Partial<Config>, "classifier"> {
	classifier?: Partial<ClassifierConfig>;
}

function normalizeSettingsConfig(value: Record<string, unknown>): NormalizedSettings {
	const normalized: NormalizedSettings = {};
	if (typeof value.enabled === "boolean") normalized.enabled = value.enabled;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	const floor = probability(value.injectionConfidenceFloor);
	if (floor !== undefined) normalized.injectionConfidenceFloor = floor;
	const budget = positiveInteger(value.maxInjectedTokens);
	if (budget !== undefined) normalized.maxInjectedTokens = budget;
	const promote = positiveInteger(value.promoteAtProjectCount);
	if (promote !== undefined) normalized.promoteAtProjectCount = promote;
	const pruneFloor = probability(value.pruneConfidenceFloor);
	if (pruneFloor !== undefined) normalized.pruneConfidenceFloor = pruneFloor;
	const extractChunk = positiveInteger(value.extractChunkMaxTokens);
	if (extractChunk !== undefined) normalized.extractChunkMaxTokens = extractChunk;
	const maxChunks = positiveInteger(value.consolidateMaxChunks);
	if (maxChunks !== undefined) normalized.consolidateMaxChunks = maxChunks;
	const reflectMax = positiveInteger(value.reflectMaxEntries);
	if (reflectMax !== undefined) normalized.reflectMaxEntries = reflectMax;
	const agentMaxTurns = positiveInteger(value.agentMaxTurns);
	if (agentMaxTurns !== undefined) normalized.agentMaxTurns = agentMaxTurns;
	const agentMaxTokens = positiveInteger(value.agentMaxTokens);
	if (agentMaxTokens !== undefined) normalized.agentMaxTokens = agentMaxTokens;
	const modelMap = normalizeModelMap(value.modelMap);
	if (modelMap) normalized.modelMap = modelMap;
	const classifier = normalizeClassifierPartial(value.classifier);
	if (classifier) normalized.classifier = classifier;
	const categories = normalizeCategoryMap(value.categories);
	if (categories) normalized.categories = categories;
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const raw = env[PASSIVE_ENV];
	if (raw === undefined) return {};
	const value = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(value)) return { passive: true };
	if (["0", "false", "no", "off"].includes(value)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string): NormalizedSettings {
	if (!existsSync(path)) return {};
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		const nested = isRecord(raw) ? raw[SETTINGS_KEY] : undefined;
		return isRecord(nested) ? normalizeSettingsConfig(nested) : {};
	} catch {
		return {};
	}
}

export function settingsPathFor(cwd: string, user = false): string {
	return user ? join(getAgentDir(), "settings.json") : join(cwd, ".pi", "settings.json");
}

/** The full taste block with every value at its default; the shape written to settings. */
export function defaultTasteSettings(): Record<string, unknown> {
	return {
		enabled: DEFAULTS.enabled,
		classifier: { ...DEFAULTS.classifier },
		categories: { ...DEFAULT_CATEGORIES },
		injectionConfidenceFloor: DEFAULTS.injectionConfidenceFloor,
		maxInjectedTokens: DEFAULTS.maxInjectedTokens,
		promoteAtProjectCount: DEFAULTS.promoteAtProjectCount,
		pruneConfidenceFloor: DEFAULTS.pruneConfidenceFloor,
		consolidateMaxChunks: DEFAULTS.consolidateMaxChunks,
		reflectMaxEntries: DEFAULTS.reflectMaxEntries,
		agentMaxTurns: DEFAULTS.agentMaxTurns,
		agentMaxTokens: DEFAULTS.agentMaxTokens,
		modelMap: [],
		debugLog: DEFAULTS.debugLog,
		passive: DEFAULTS.passive,
	};
}

/**
 * Read the user `taste` block, filling every missing value from the defaults and
 * writing the completed block back on first use. The settings file is the source
 * of truth, so nothing is applied silently at runtime; the defaults exist only to
 * seed a config that does not yet exist. Returns the filled block even when the
 * file is read-only, so a session can still run.
 */
export function ensureTasteSettings(cwd: string): Record<string, unknown> {
	const path = settingsPathFor(cwd, true);
	const defaults = defaultTasteSettings();
	let root: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (isRecord(parsed)) root = parsed;
		} catch {
			root = {};
		}
	}

	const existing = isRecord(root[SETTINGS_KEY]) ? root[SETTINGS_KEY] as Record<string, unknown> : undefined;
	let filled: Record<string, unknown>;
	let dirty = false;
	if (!existing) {
		filled = defaults;
		dirty = true;
	} else {
		filled = { ...existing };
		for (const [key, value] of Object.entries(defaults)) {
			if (filled[key] === undefined) {
				filled[key] = value;
				dirty = true;
			}
		}
		const classifier = isRecord(filled.classifier) ? filled.classifier : {};
		const withClassifierDefaults = { ...(defaults.classifier as Record<string, unknown>), ...classifier };
		if (JSON.stringify(withClassifierDefaults) !== JSON.stringify(classifier)) dirty = true;
		filled.classifier = withClassifierDefaults;
		const categories = isRecord(filled.categories) && Object.keys(filled.categories).length > 0 ? filled.categories : undefined;
		if (!categories) {
			filled.categories = { ...DEFAULT_CATEGORIES };
			dirty = true;
		}
	}

	root[SETTINGS_KEY] = filled;
	if (dirty) {
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf-8");
		} catch {
			// Read-only settings: run with the filled in-memory block.
		}
	}
	return filled;
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	// Materializes the full default block on first use, then reads it back.
	const globalConfig = normalizeSettingsConfig(ensureTasteSettings(cwd));
	const projectConfig = readNamespacedConfig(settingsPathFor(cwd, false));
	const envConfig = readEnvConfig(env);
	const merged: Config = {
		...DEFAULTS,
		...globalConfig,
		...projectConfig,
		...envConfig,
		classifier: {
			...CLASSIFIER_DEFAULTS,
			...globalConfig.classifier,
			...projectConfig.classifier,
			...(envConfig.classifier as Partial<ClassifierConfig> | undefined),
		},
		// Only configured categories exist; the defaults live in the settings file.
		categories: projectConfig.categories ?? globalConfig.categories ?? {},
		modelMap: projectConfig.modelMap ?? globalConfig.modelMap ?? DEFAULTS.modelMap,
	};
	return merged;
}

/**
 * Turn taste learning on or off by writing the namespaced setting. User scope by
 * default; `project` targets `./.pi/settings.json`. Returns the file path written,
 * for the command to report.
 */
export function setTasteEnabled(args: { cwd: string; enabled: boolean; scope?: "user" | "project" }): string {
	const path = settingsPathFor(args.cwd, args.scope !== "project");
	let raw: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (isRecord(parsed)) raw = { ...parsed };
		} catch {
			// A malformed settings file is replaced by a minimal valid one.
		}
	}
	const existing = isRecord(raw[SETTINGS_KEY]) ? { ...raw[SETTINGS_KEY] } : {};
	existing.enabled = args.enabled;
	raw[SETTINGS_KEY] = existing;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
	return path;
}
