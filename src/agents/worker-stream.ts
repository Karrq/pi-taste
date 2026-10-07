import type { AssistantMessageEventStream, Context, KnownApi, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getApiProvider, streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";

export type WorkerStreamSimple = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Duck-typed subset of pi's extension ModelRegistry used to reach a composed stream. */
export type StreamableModelRegistry = {
	streamSimple?: WorkerStreamSimple;
	getRegisteredProviderConfig?: (providerId: string) => {
		api?: string;
		streamSimple?: WorkerStreamSimple;
	} | undefined;
};

const BUILTIN_APIS: Record<KnownApi, true> = {
	"openai-completions": true,
	"mistral-conversations": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
	"anthropic-messages": true,
	"bedrock-converse-stream": true,
	"google-generative-ai": true,
	"google-vertex": true,
	"pi-messages": true,
};

/**
 * Resolve the stream function background workers pass to `agentLoop`.
 *
 * Direct compat `streamSimple` only knows built-in API ids, so a custom
 * provider (registered on pi's composed runtime) must go through the registry's
 * own stream function instead.
 */
export function resolveWorkerStreamSimple(
	model: Model<any>,
	modelRegistry?: StreamableModelRegistry | null,
	override?: WorkerStreamSimple,
): WorkerStreamSimple {
	if (override) return override;

	if (!Object.hasOwn(BUILTIN_APIS, model.api) && getApiProvider(model.api)) {
		return compatStreamSimple;
	}

	const registryStream = modelRegistry?.streamSimple;
	if (typeof registryStream === "function") {
		return (nextModel, context, options) => registryStream.call(modelRegistry, nextModel, context, options);
	}

	try {
		const config = modelRegistry?.getRegisteredProviderConfig?.(model.provider);
		const composed = config?.streamSimple;
		if (config?.api === model.api && typeof composed === "function") {
			return composed;
		}
	} catch {
		// Incomplete host/test doubles still use the built-in compat dispatcher.
	}

	return compatStreamSimple;
}
