import type {
	ClassifierApi,
	ClassifierModel,
	ClassifierQuestion,
	ClassifierResult,
	JsonObject,
} from "@earendil-works/pi-ai";

export type { ClassifierAnswer, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";

/** The pi ModelRegistry methods the distill stage uses. */
export interface ClassifierRegistry {
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: { state: JsonObject; questions: Record<string, ClassifierQuestion> },
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<ClassifierResult>;
	getModelsOfType(type: "classifier", provider?: string): readonly ClassifierModel<ClassifierApi>[];
	findOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
}

export type Classify = (
	state: JsonObject,
	questions: Record<string, ClassifierQuestion>,
) => Promise<{ answers: ClassifierResult["answers"]; usage?: ClassifierResult["usage"] }>;

export interface ClassifierSelection {
	provider: string;
	model?: string;
}

/** pi-jev registers this provider for its local open-jev endpoint. */
export const DEFAULT_CLASSIFIER_PROVIDER = "local-jev";

export function findClassifierModel(
	registry: ClassifierRegistry,
	selection: ClassifierSelection,
): ClassifierModel<ClassifierApi> | undefined {
	const provider = selection.provider || DEFAULT_CLASSIFIER_PROVIDER;
	if (selection.model) {
		return (
			registry.findOfType("classifier", provider, selection.model)
			?? registry.getModelsOfType("classifier", provider).find((model) => model.id === selection.model)
		);
	}
	return registry.getModelsOfType("classifier", provider)[0];
}

/**
 * Bind one classifier model and timeout into the call shape the distill stage
 * uses. Undefined means no classifier is registered, so the caller falls back to
 * the heuristic.
 */
export function resolveClassifier(
	registry: ClassifierRegistry | undefined,
	selection: ClassifierSelection,
	timeoutMs: number,
): Classify | undefined {
	if (!registry) return undefined;
	const model = findClassifierModel(registry, selection);
	if (!model) return undefined;
	return async (state, questions) => {
		const result = await registry.classify(model, { state, questions }, { timeoutMs });
		if (result.stopReason !== "stop") {
			throw new Error(
				`System One classification via ${model.provider}/${model.id} failed: ${result.errorMessage ?? result.stopReason}`,
			);
		}
		return { answers: result.answers, usage: result.usage };
	};
}
