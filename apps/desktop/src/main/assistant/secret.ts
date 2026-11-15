/**
 * Mint a short-lived Realtime client secret for the hidden assistant window (the standard API key never
 * leaves main). Session config is the GA shape verified by scripts/realtime-smoke.ts. No electron import.
 */
import { FALLBACK_REASONING_EFFORT, assistantSessionConfig, reasoningEffort, realtimeModel } from "./realtimeProtocol";

export interface AssistantSecret {
  value: string;
  expiresAt: number;
  model: string;
  effort?: string;
}

export async function mintAssistantSecret(opts: {
  apiKey: string | undefined;
  instructions: string;
  tools: unknown[];
  fetch?: typeof fetch;
  model?: string;
  effort?: string;
}): Promise<AssistantSecret> {
  if (!opts.apiKey) throw new Error("OPENAI_API_KEY is not set (add it to the repo-root .env)");
  const model = opts.model ?? realtimeModel();
  const f = opts.fetch ?? fetch;
  const attempt = async (effort: string | undefined) => {
    const res = await f("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: assistantSessionConfig({ instructions: opts.instructions, tools: opts.tools, model, effort }),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { value?: string; expires_at?: number; error?: { message?: string; param?: string } };
    return { res, data };
  };
  let effort: string | undefined = opts.effort ?? reasoningEffort();
  let { res, data } = await attempt(effort);
  // The API rejected the effort value (e.g. "minimal" unsupported on this model): retry once with "low".
  if (!res.ok && effort && effort !== FALLBACK_REASONING_EFFORT && /reasoning|effort/i.test(`${data.error?.param ?? ""} ${data.error?.message ?? ""}`)) {
    effort = FALLBACK_REASONING_EFFORT;
    ({ res, data } = await attempt(effort));
  }
  if (!res.ok || !data.value) throw new Error(`client_secrets ${res.status}: ${data.error?.message ?? "no value in response"}`);
  return { value: data.value, expiresAt: data.expires_at ?? 0, model, effort };
}
