import type { SelectionSnapshot } from "@pointy/shared/context/selection";

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

/** Default SCTP max message size when the peer connection does not report one. */
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;

export interface SelectionItems {
  /** conversation.item.create events to send, in order. Never includes response.create. */
  events: object[];
  /** Human-readable description of what was sent (for the log). */
  note: string;
}

const r = (n: number) => Math.round(n);

/** The explanatory text that accompanies the images. */
export function selectionText(s: SelectionSnapshot, images: "both" | "focus" | "focus_then_full" | "none" = "both"): string {
  const b = s.regionGlobal;
  const bbox = `x=${r(b.x)}, y=${r(b.y)}, ${r(b.width)}x${r(b.height)}`;
  const geometry =
    s.kind === "region" && s.polygonGlobal?.length
      ? `bbox ${bbox}, polygon ${JSON.stringify(s.polygonGlobal.map((p) => [r(p.x), r(p.y)]))}`
      : s.pointGlobal
        ? `point (${r(s.pointGlobal.x)}, ${r(s.pointGlobal.y)}), focus box ${bbox}`
        : `bbox ${bbox}`;
  const what = s.kind === "region" ? "a region" : "a point";
  const imgs =
    images === "both"
      ? "Image 1 is the whole screen for context with the selection outlined (everything else dimmed). Image 2 is a close-up of the selection."
      : images === "focus_then_full"
        ? "The attached image is a close-up of the selection; the whole screen (selection outlined, everything else dimmed) follows in the next message."
        : images === "focus"
          ? "The attached image is a close-up of the selection (the whole-screen view could not be sent)."
        : "The images could not be sent; do not claim to see the selection.";
  return `[selection] The user just selected ${what} on screen. ${imgs} Focus your answer on the selected part. Selection in global DIP: ${geometry} (use it as a highlight / show_explainer target if useful).`;
}

const bytesOf = (e: object) => new TextEncoder().encode(JSON.stringify(e)).byteLength;
const userItem = (content: object[]) => ({ type: "conversation.item.create", item: { type: "message", role: "user", content } });
const image = (dataUrl: string) => ({ type: "input_image", image_url: dataUrl, detail: "auto" });
const text = (t: string) => ({ type: "input_text", text: t });

/**
 * Build the conversation items that hand a gesture selection to GPT Realtime. Tries both images in
 * one message; if that exceeds maxMessageBytes falls back to focus + (full alone), then focus only,
 * then text only. Never returns an event larger than maxMessageBytes.
 */
export function selectionItems(s: SelectionSnapshot, opts: { maxMessageBytes?: number } = {}): SelectionItems {
  const max = opts.maxMessageBytes && opts.maxMessageBytes > 0 ? opts.maxMessageBytes : DEFAULT_MAX_MESSAGE_BYTES;
  const kb = (e: object) => `${Math.round(bytesOf(e) / 1024)}KB`;
  const both = userItem([text(selectionText(s, "both")), image(s.full.dataUrl), image(s.focus.dataUrl)]);
  if (bytesOf(both) <= max) return { events: [both], note: `full+focus in one message (${kb(both)}, limit ${Math.round(max / 1024)}KB)` };

  const focusOnly = userItem([text(selectionText(s, "focus")), image(s.focus.dataUrl)]);
  const fullAlone = userItem([text("[selection] Context: the whole screen with the selection outlined (everything else dimmed)."), image(s.full.dataUrl)]);
  if (bytesOf(focusOnly) <= max) {
    if (bytesOf(fullAlone) <= max) {
      const focusFirst = userItem([text(selectionText(s, "focus_then_full")), image(s.focus.dataUrl)]);
      return { events: [focusFirst, fullAlone], note: `too big for one message; sent focus (${kb(focusOnly)}) then full (${kb(fullAlone)}) separately` };
    }
    return { events: [focusOnly], note: `too big; sent focus only (${kb(focusOnly)}), full dropped` };
  }
  const textOnly = userItem([text(selectionText(s, "none"))]);
  return { events: [textOnly], note: `images exceed ${Math.round(max / 1024)}KB; sent geometry text only` };
}
