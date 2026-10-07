import { normalizeTasteContent, type TasteEntry } from "../ledger/types.js";

export interface RenderOptions {
	confidenceFloor: number;
	maxTokens: number;
}

const HEADER = "Learned coding preferences. Follow these unless the user says otherwise.";

/** Rough chars-per-token estimate, matching the rest of the extension's budgeting. */
function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Combine the project and global layers into one list. A project entry wins over
 * a global entry with the same normalized content, because the project statement
 * is the more specific evidence.
 */
export function mergeTasteEntries(
	project: readonly TasteEntry[],
	global: readonly TasteEntry[],
): TasteEntry[] {
	const byKey = new Map<string, TasteEntry>();
	for (const entry of global) byKey.set(normalizeTasteContent(entry.content), entry);
	for (const entry of project) byKey.set(normalizeTasteContent(entry.content), entry);
	return Array.from(byKey.values());
}

/**
 * Render the injectable `<taste>` section: filter by confidence floor, sort by
 * confidence, and stop before the token budget. Returns undefined when nothing
 * clears the floor, so the caller can leave the system prompt untouched.
 */
export function renderTasteSection(entries: readonly TasteEntry[], options: RenderOptions): string | undefined {
	const eligible = entries
		.filter((entry) => entry.confidence >= options.confidenceFloor)
		.sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt));

	const lines: string[] = [];
	let tokens = approxTokens(HEADER);
	for (const entry of eligible) {
		const line = `- ${entry.content} (${Math.round(entry.confidence * 100)}%, ${entry.category})`;
		const cost = approxTokens(line);
		if (tokens + cost > options.maxTokens) break;
		lines.push(line);
		tokens += cost;
	}
	if (lines.length === 0) return undefined;
	return `<taste>\n${HEADER}\n${lines.join("\n")}\n</taste>`;
}
