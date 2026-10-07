import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/** The pipeline stages, each independently routable to a model. */
export const TASTE_STAGES = ["extract", "distill", "reconcile", "prune"] as const;
export type TasteStage = (typeof TASTE_STAGES)[number];

/**
 * Glob-matched routing for a stage's model. `match` tests the active session
 * model's `"<provider>/<id>"`; the first matching entry wins. `model` is
 * `"<provider>/<id>[:<thinking>]"` with `$provider`, `$id`, `$model`, and
 * `$thinking` substitutions from the session model.
 */
export interface ModelMapEntry {
	match: string;
	stages?: TasteStage[];
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

export interface Config {
	/**
	 * Master switch. When false nothing is injected. `/taste consolidate` and
	 * `/taste remember` still write the ledger, since those are explicit user
	 * actions.
	 */
	enabled: boolean;
	classifier: ClassifierConfig;
	/** Entries below this confidence are not injected. */
	injectionConfidenceFloor: number;
	/** Approximate token budget for the injected `<taste>` section. */
	maxInjectedTokens: number;
	/** Promote a preference to the global ledger once seen in this many projects. */
	promoteAtProjectCount: number;
	/** Estimated token cap for one extraction chunk. Unset derives ~1/5 of the model window. */
	extractChunkMaxTokens?: number;
	/** Maximum extraction chunks one `/taste consolidate` run may process. */
	consolidateMaxChunks: number;
	agentMaxTurns: number;
	agentMaxTokens: number;
	model?: ConfiguredModel;
	fallbackModel?: ConfiguredModel;
	modelMap: ModelMapEntry[];
	debugLog: boolean;
	/** Disable all work without touching settings. */
	passive: boolean;
}

export const DEFAULTS: Config = {
	enabled: false,
	classifier: { ...CLASSIFIER_DEFAULTS },
	injectionConfidenceFloor: 0.5,
	maxInjectedTokens: 1_200,
	promoteAtProjectCount: 2,
	extractChunkMaxTokens: undefined,
	consolidateMaxChunks: 8,
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

function isTasteStage(value: unknown): value is TasteStage {
	return typeof value === "string" && (TASTE_STAGES as readonly string[]).includes(value);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function probability(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
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
	stage?: TasteStage,
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
	return config.model;
}

function normalizeModel(value: unknown): ConfiguredModel | undefined {
	if (!isRecord(value)) return undefined;
	const provider = nonEmptyString(value.provider);
	const id = nonEmptyString(value.id);
	if (!provider || !id) return undefined;
	const model: ConfiguredModel = { provider, id };
	if (isThinkingLevel(value.thinking)) model.thinking = value.thinking;
	return model;
}

function normalizeStages(value: unknown): TasteStage[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const stages = value.filter(isTasteStage);
	return stages.length > 0 ? [...new Set(stages)] : undefined;
}

function normalizeModelMapEntry(value: unknown): ModelMapEntry | undefined {
	if (!isRecord(value)) return undefined;
	const match = nonEmptyString(value.match);
	const model = nonEmptyString(value.model);
	if (!match || !model || !model.includes("/")) return undefined;
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
	const extractChunk = positiveInteger(value.extractChunkMaxTokens);
	if (extractChunk !== undefined) normalized.extractChunkMaxTokens = extractChunk;
	const maxChunks = positiveInteger(value.consolidateMaxChunks);
	if (maxChunks !== undefined) normalized.consolidateMaxChunks = maxChunks;
	const agentMaxTurns = positiveInteger(value.agentMaxTurns);
	if (agentMaxTurns !== undefined) normalized.agentMaxTurns = agentMaxTurns;
	const agentMaxTokens = positiveInteger(value.agentMaxTokens);
	if (agentMaxTokens !== undefined) normalized.agentMaxTokens = agentMaxTokens;
	const model = normalizeModel(value.model);
	if (model) normalized.model = model;
	const fallbackModel = normalizeModel(value.fallbackModel);
	if (fallbackModel) normalized.fallbackModel = fallbackModel;
	const modelMap = normalizeModelMap(value.modelMap);
	if (modelMap) normalized.modelMap = modelMap;
	const classifier = normalizeClassifierPartial(value.classifier);
	if (classifier) normalized.classifier = classifier;
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

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalConfig = readNamespacedConfig(settingsPathFor(cwd, true));
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
		modelMap: projectConfig.modelMap ?? globalConfig.modelMap ?? DEFAULTS.modelMap,
	};
	return merged;
}

/**
 * Turn taste learning on or off by writing the namespaced setting. Project scope
 * by default; `user` targets `~/.pi/agent/settings.json`. Returns the file path
 * written, for the command to report.
 */
export function setTasteEnabled(args: { cwd: string; enabled: boolean; user?: boolean }): string {
	const path = settingsPathFor(args.cwd, args.user === true);
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
