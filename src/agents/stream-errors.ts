/** Best-effort debug hook for worker stream failures. Never throws, never noisy. */
export function logAgentStreamError(stage: string, event: unknown): void {
	const message = (event as { message?: { role?: string; stopReason?: string } }).message;
	if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
		void stage;
	}
}
