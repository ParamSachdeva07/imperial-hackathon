/**
 * DEV-ONLY GPT Realtime test harness (main side). Lets a developer talk to GPT Realtime and have it
 * call the real overlay tools against the fixture window. Not part of the product voice path
 * (that belongs to the voice/agent teammate).
 *
 * The standard OPENAI_API_KEY never leaves the main process: we mint a short-lived client secret
 * (POST /v1/realtime/client_secrets) and hand only that to the voice window, which then does the
 * WebRTC SDP exchange with POST /v1/realtime/calls. (API verified against the OpenAI docs, Nov 2026.)
 */
import { exportToolDefinitions, type DisplayInfo, type ElementRect } from "@pointy/shared/overlay";

export const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";
const SECRET_TTL_SECONDS = 600;

export interface HarnessContext {
  listElements(): ElementRect[];
  getDisplays(): DisplayInfo[];
  primaryDisplayId(): string;
  /** imagePrompts with pre-generated images (instant, offline). */
  pregeneratedImagePrompts(): Promise<string[]>;
}

export function buildInstructions(ctx: HarnessContext): string {
  const elements = ctx
    .listElements()
    .map((e) => `- ${e.id} (x=${Math.round(e.rect.x)}, y=${Math.round(e.rect.y)}, ${Math.round(e.rect.width)}×${Math.round(e.rect.height)})`)
    .join("\n");
  const displays = ctx
    .getDisplays()
    .map((d) => `- display ${d.id}${d.id === ctx.primaryDisplayId() ? " (primary)" : ""}: x=${d.bounds.x}, y=${d.bounds.y}, ${d.bounds.width}×${d.bounds.height}`)
    .join("\n");
  return `You are Pointy, a calm, patient helper for an older person using a computer. Speak in short, warm, simple sentences.
You can draw on the user's screen with your tools: point_at, highlight, show_steps, advance_step, show_explainer, clear and move_avatar.
Use them whenever showing helps: point at what to press next, highlight what they ask about (spotlight when they ask where something is, tone "warning" for anything risky), show numbered steps for multi-step tasks, and show a picture card only when a picture explains better than words.
Always prefer element targets: {"kind":"element","elementId":"<id>"}. Only use these element ids (they are on screen now):
${elements || "- (no elements reported yet)"}
Coordinates are global points; displays:
${displays}
move_avatar moves the avatar bubble out of the way if it covers something you need to show; it also dodges by itself, so rarely call it.
When a tool result says visible:false, tell the user you can't see that right now. Call clear with "all" when the user says "got it", "okay" or changes topic.
This is a developer test session: if the developer asks you to draw something specific, do exactly that.`;
}

export async function mintClientSecret(apiKey: string, ctx: HarnessContext): Promise<{ value: string; expiresAt: number; model: string }> {
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: SECRET_TTL_SECONDS },
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        instructions: buildInstructions(ctx),
        audio: {
          input: { transcription: { model: "gpt-4o-transcribe" } },
          output: { voice: "marin" },
        },
        tools: exportToolDefinitions({ pregeneratedImagePrompts: await ctx.pregeneratedImagePrompts() }),
        tool_choice: "auto",
      },
    }),
  });
  const data = (await res.json()) as { value?: string; expires_at?: number; error?: { message?: string } };
  if (!res.ok || !data.value) throw new Error(`client_secrets ${res.status}: ${data.error?.message ?? "no value in response"}`);
  return { value: data.value, expiresAt: data.expires_at ?? 0, model: REALTIME_MODEL };
}
