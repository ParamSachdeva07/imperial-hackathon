/**
 * DEV-ONLY: handles GPT Realtime server events from the `oai-events` data channel.
 * Pure (deps injected) so it can be unit-tested without WebRTC.
 *
 *  - input_audio_buffer.speech_started → a new user turn (overlay onTurnStart)
 *  - response.done with function_call items → run each tool, send function_call_output for each,
 *    then one response.create so the model can speak about the results
 *  - transcripts → caption log
 */
export interface RealtimeDeps {
  send(event: object): void;
  callTool(name: string, args: unknown): Promise<unknown>;
  turnStart(turnId: string): Promise<void> | void;
  /** Current instructions (fresh on-screen element list), sent as a session.update each turn. */
  instructions?(): Promise<string>;
  log(kind: "you" | "pointy" | "tool" | "error" | "info", text: string): void;
  newTurnId(): string;
}

interface FunctionCallItem {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
}

type ServerEvent = { type: string; [k: string]: unknown };

export async function handleServerEvent(ev: ServerEvent, deps: RealtimeDeps): Promise<void> {
  switch (ev.type) {
    case "input_audio_buffer.speech_started": {
      await deps.turnStart(deps.newTurnId());
      // Windows may have moved/opened since the session began: refresh what the AI can point at.
      const instructions = await deps.instructions?.().catch(() => null);
      if (instructions) deps.send({ type: "session.update", session: { type: "realtime", instructions } });
      return;
    }
    case "conversation.item.input_audio_transcription.completed":
      if (typeof ev.transcript === "string" && ev.transcript.trim()) deps.log("you", ev.transcript.trim());
      return;
    case "response.output_audio_transcript.done":
      if (typeof ev.transcript === "string" && ev.transcript.trim()) deps.log("pointy", ev.transcript.trim());
      return;
    case "error": {
      const err = ev.error as { message?: string } | undefined;
      deps.log("error", err?.message ?? JSON.stringify(ev));
      return;
    }
    case "response.done": {
      const response = ev.response as { output?: unknown[] } | undefined;
      const calls = (response?.output ?? []).filter(
        (o): o is FunctionCallItem => typeof o === "object" && o !== null && (o as { type?: string }).type === "function_call",
      );
      if (calls.length === 0) return;
      for (const call of calls) {
        let args: unknown;
        let output: unknown;
        try {
          args = JSON.parse(call.arguments || "{}");
          output = await deps.callTool(call.name, args);
        } catch (e) {
          output = { ok: false, visible: false, reason: "invalid_input", error: String(e) };
        }
        deps.log("tool", `${call.name}(${call.arguments}) → ${JSON.stringify(output)}`);
        deps.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) } });
      }
      deps.send({ type: "response.create" });
      return;
    }
  }
}
