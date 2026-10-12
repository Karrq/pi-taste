import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { registerTasteSnapshotRenderer, syncTasteSnapshot } from "../taste-snapshot.js";

/**
 * Cache-safe injection.
 *
 * The snapshot is rebuilt only at session start and immediately after a
 * compaction. Between those points `runtime.tasteSnapshot` is byte-identical, so
 * the system prompt returned from `before_agent_start` is unchanged and the
 * cached prefix survives. A compaction already invalidates the cache, so that is
 * the only free moment to refresh.
 *
 * Each refresh that changes the injected text appends a `taste.snapshot` entry,
 * so the transcript shows when the block was loaded or changed.
 */
export function registerTasteInjection(pi: ExtensionAPI, runtime: Runtime): void {
	registerTasteSnapshotRenderer(pi);
	pi.on("session_start", (_event, ctx) => {
		syncTasteSnapshot(pi, runtime, ctx.cwd);
	});
	pi.on("session_compact", (_event, ctx) => {
		syncTasteSnapshot(pi, runtime, ctx.cwd);
	});
	pi.on("before_agent_start", (event) => {
		const section = runtime.tasteSnapshot;
		if (!section) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
	});
}
