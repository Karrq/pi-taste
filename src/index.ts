import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTasteCommand } from "./commands/taste.js";
import { registerTasteInjection } from "./hooks/injection.js";
import { Runtime } from "./runtime.js";

export default function taste(pi: ExtensionAPI) {
	const runtime = new Runtime();
	registerTasteInjection(pi, runtime);
	registerTasteCommand(pi, runtime);
}
