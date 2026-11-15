/**
 * Mint a short-lived Realtime client secret for the hidden assistant window (the standard API key never
 * leaves main). Session config is the GA shape verified by scripts/realtime-smoke.ts. No electron import.
 */
import { assistantSessionConfig, realtimeModel } from "./realtimeProtocol";

export interface AssistantSecret {
  value: string;
  expiresAt: number;
  model: string;
}

export async function mintAssistantSecret(opts: {
  apiKey: string | undefined;
  instructions: string;
  tools: unknown[];
  fetch?: typeof fetch;
  model?: string;
}): Promise<AssistantSecret> {
  if (!opts.apiKey) throw new Error("OPENAI_API_KEY is not set (add it to the repo-root .env)");
  const model = opts.model ?? realtimeModel();
  const f = opts.fetch ?? fetch;
  const res = await f("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: assistantSessionConfig({ instructions: opts.instructions, tools: opts.tools, model }),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { value?: string; expires_at?: number; error?: { message?: string } };
  if (!res.ok || !data.value) throw new Error(`client_secrets ${res.status}: ${data.error?.message ?? "no value in response"}`);
  return { value: data.value, expiresAt: data.expires_at ?? 0, model };
}
