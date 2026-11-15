/** The tool that lets the model end the call itself, when the user says goodbye. No electron import. */
import type { Clock } from "../overlay/clock";
import type { AssistantStatus } from "./status";

export const END_CALL_TOOL = {
  type: "function" as const,
  name: "end_call",
  description:
    "End this call. Use it when the user says goodbye, says they are done, or asks you to go away. Say a short goodbye in the same answer; the call closes once you have finished speaking. Do not use it just because the conversation went quiet.",
  parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
};

/**
 * Close once the goodbye has been spoken: wait for the assistant to be back to listening (or already gone), with a
 * ceiling so a stuck answer cannot keep the call open. Returns a function that cancels the pending close.
 */
export function closeAfterGoodbye(deps: { status(): AssistantStatus; close(): void; clock: Clock; settleMs?: number; maxWaitMs?: number }): () => void {
  const started = deps.clock.now();
  let cancelled = false;
  const check = (): void => {
    if (cancelled) return;
    const s = deps.status();
    if (s === "idle" || s === "error") return; // already closed
    if (s === "listening" || deps.clock.now() - started >= (deps.maxWaitMs ?? 15_000)) return deps.close();
    deps.clock.setTimeout(check, 300);
  };
  // The goodbye is spoken after this tool returns, so give it a moment to start before checking.
  deps.clock.setTimeout(check, deps.settleMs ?? 2500);
  return () => {
    cancelled = true;
  };
}
