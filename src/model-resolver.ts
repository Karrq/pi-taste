import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { resolveConfiguredModel, type TasteStage } from "./config.js";
import type { Runtime } from "./runtime.js";

export interface ResolveModelCtx {
	model: unknown;
	modelRegistry: unknown;
	stage: TasteStage;
	thinkingLevel?: ModelThinkingLevel;
}

export interface ResolvedWorkerModel {
	model: any;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	baseUrl?: string;
	thinking?: ModelThinkingLevel;
	fallbackUsed?: boolean;
	primaryFailure?: string;
}

type AuthPayload = { ok?: boolean; apiKey?: unknown; headers?: unknown; env?: unknown; baseUrl?: unknown };

function usableHeaderCount(headers: unknown): number {
	if (!headers || typeof headers !== "object") return 0;
	return Object.values(headers as Record<string, unknown>).filter(
		(value) => typeof value === "string" && value.length > 0,
	).length;
}

/** Mirrors pi's request-auth acceptance rule: an apiKey OR at least one usable header. */
function hasUsableAuth(auth: AuthPayload): boolean {
	if (typeof auth.apiKey === "string" && auth.apiKey.length > 0) return true;
	return usableHeaderCount(auth.headers) > 0;
}

/** True when pi reports a credential source, i.e. a provider that signs at request time. */
function hasConfiguredProviderCredential(registry: unknown, model: unknown): boolean {
	try {
		return (registry as { hasConfiguredAuth?: (m: unknown) => unknown }).hasConfiguredAuth?.(model) === true;
	} catch {
		return false;
	}
}

type CandidateResult =
	| { ok: true; model: any; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string>; baseUrl?: string }
	| { ok: false; reason: string };

async function resolveCandidate(registry: any, model: unknown): Promise<CandidateResult> {
	const auth = (await registry.getApiKeyAndHeaders(model)) as AuthPayload;
	const provider = (model as { provider?: string }).provider ?? "unknown";
	const isOAuth = registry.isUsingOAuth?.(model) === true;
	const usable = hasUsableAuth(auth);
	const resolvedEmptyApiKey = typeof auth.apiKey === "string" && auth.apiKey.length === 0;
	const providerCredentialConfigured = hasConfiguredProviderCredential(registry, model);
	// Providers that sign requests themselves (Bedrock SigV4, Vertex ADC) resolve
	// ok with nothing to attach; keep those working without treating the empty
	// payload as "unauthenticated".
	const signsAtRequestTime = auth.ok === true && !isOAuth && !resolvedEmptyApiKey && providerCredentialConfigured;
	if (auth.ok !== true || (!usable && !signsAtRequestTime)) {
		const reason = isOAuth
			? `authentication failed for provider "${provider}"; run '/login ${provider}'`
			: `no API key or auth headers for provider "${provider}"`;
		return { ok: false, reason };
	}
	const requestModel = auth.baseUrl ? { ...(model as object), baseUrl: auth.baseUrl } : model;
	return {
		ok: true,
		model: requestModel,
		apiKey: auth.apiKey as string | undefined,
		headers: auth.headers as Record<string, string> | undefined,
		env: auth.env as Record<string, string> | undefined,
		baseUrl: auth.baseUrl as string | undefined,
	};
}

/**
 * Resolve the model a taste stage should use: the configured model (or
 * `modelMap` match) when it resolves in pi's registry, else the session model,
 * then the configured fallback model when the primary is unusable.
 */
export async function resolveTasteModel(
	runtime: Runtime,
	ctx: ResolveModelCtx,
): Promise<ResolvedWorkerModel | undefined> {
	const registry = ctx.modelRegistry as any;
	let model = ctx.model;
	const configured = resolveConfiguredModel(runtime.config, ctx.model, ctx.stage, ctx.thinkingLevel);
	let thinking = configured?.thinking;
	if (configured) {
		const found = registry.find?.(configured.provider, configured.id);
		if (found) model = found;
		else thinking = undefined;
	}
	if (!model) return undefined;

	const primary = await resolveCandidate(registry, model);
	if (primary.ok) return { ...primary, thinking };

	const fallback = runtime.config.fallbackModel;
	if (!fallback) return undefined;
	const fallbackModel = registry.find?.(fallback.provider, fallback.id);
	if (!fallbackModel) return undefined;
	const resolvedFallback = await resolveCandidate(registry, fallbackModel);
	if (!resolvedFallback.ok) return undefined;
	return {
		...resolvedFallback,
		thinking: fallback.thinking,
		fallbackUsed: true,
		primaryFailure: primary.reason,
	};
}
