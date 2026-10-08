import { normalizeTasteContent, type TasteEntry } from "./ledger/index.js";

/**
 * Resolve a command selector to one entry. `id:<value>` matches by id (exact,
 * then prefix); anything else matches by normalized content (exact, then
 * substring). The explicit `id:` prefix is what keeps an identifier from being
 * read as content.
 */
export function findEntry(entries: readonly TasteEntry[], selector: string): TasteEntry | undefined {
	const trimmed = selector.trim();
	if (trimmed.startsWith("id:")) {
		const id = trimmed.slice(3).trim();
		if (!id) return undefined;
		return entries.find((entry) => entry.id === id) ?? entries.find((entry) => entry.id.startsWith(id));
	}
	const needle = normalizeTasteContent(trimmed);
	if (!needle) return undefined;
	return (
		entries.find((entry) => normalizeTasteContent(entry.content) === needle)
		?? entries.find((entry) => normalizeTasteContent(entry.content).includes(needle))
	);
}
