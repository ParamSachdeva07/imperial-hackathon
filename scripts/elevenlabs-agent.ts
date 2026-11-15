/**
 * Create or update the ElevenLabs agent that is the voice of the assistant when it runs through Anam.
 *
 *   tsx scripts/elevenlabs-agent.ts --print     print the agent definition, call nothing
 *   tsx scripts/elevenlabs-agent.ts             create the tools and the agent (needs ELEVENLABS_API_KEY)
 *   ELEVENLABS_AGENT_ID=... tsx scripts/...     update that agent instead of creating one
 *
 * Model: GPT-6.1 Sol on the fast service tier. Every tool is a client tool that waits for its result, so
 * the app (through the Anam SDK) runs it and the result joins the conversation.
 */
import { exportToolDefinitions } from "../packages/shared/src/overlay/tools";
import { buildAssistantInstructions } from "../apps/desktop/src/main/assistant/instructions";
import { EXECUTION_TOOLS } from "../apps/desktop/src/main/execution/ExecutionTools";

const API = "https://api.elevenlabs.io/v1/convai";

export const LOOK_AT_SCREEN = {
  type: "function" as const,
  name: "look_at_screen",
  description:
    "See the user's screen right now: the controls on it, what the pointer is on, and what they selected. Call it before answering anything about the screen, and again whenever the screen may have changed.",
  parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
};

/** The spoken-agent prompt: the same rules as today, with the screen fetched by a tool instead of pushed each turn. */
export function agentPrompt(): string {
  return (
    buildAssistantInstructions({ images: false, execution: true }) +
    '\n\nYou do not receive the "[screen]" message automatically in this mode. Call look_at_screen to get it; its result is that message. Never describe the screen from memory.'
  );
}

export function agentDefinition(toolIds: string[] = []) {
  return {
    name: process.env.ELEVENLABS_AGENT_NAME || "Desktop assistant",
    conversation_config: {
      agent: {
        language: "en",
        prompt: {
          prompt: agentPrompt(),
          llm: process.env.ELEVENLABS_LLM || "gpt-6.1-sol",
          service_tier: process.env.ELEVENLABS_SERVICE_TIER || "fast",
          reasoning_effort: process.env.ELEVENLABS_REASONING_EFFORT || "low",
          tool_ids: toolIds,
        },
      },
      // Anam accepts only this input format. Pick the V3 Conversational voice in the dashboard, or name its model id here.
      asr: { user_input_audio_format: "pcm_16000" },
      ...(process.env.ELEVENLABS_TTS_MODEL ? { tts: { model_id: process.env.ELEVENLABS_TTS_MODEL } } : {}),
    },
  };
}

export function toolConfigs() {
  return [...exportToolDefinitions({}), ...EXECUTION_TOOLS, LOOK_AT_SCREEN].map((t) => ({
    type: "client",
    name: t.name,
    description: t.description,
    expects_response: true,
    parameters: t.parameters,
  }));
}

async function call(method: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(API + path, {
    method,
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 600)}`);
  return data;
}

async function main(): Promise<void> {
  if (process.argv.includes("--print")) {
    console.log(JSON.stringify({ tools: toolConfigs(), agent: agentDefinition(["<tool ids>"]) }, null, 2));
    return;
  }
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("Set ELEVENLABS_API_KEY, or run with --print to see the definition.");
  const toolIds: string[] = [];
  for (const tool_config of toolConfigs()) {
    const created = await call("POST", "/tools", { tool_config });
    toolIds.push(String(created.id));
    console.log(`tool ${tool_config.name} -> ${String(created.id)}`);
  }
  const existing = process.env.ELEVENLABS_AGENT_ID;
  const agent = existing ? await call("PATCH", `/agents/${existing}`, agentDefinition(toolIds)) : await call("POST", "/agents/create", agentDefinition(toolIds));
  console.log(`agent ${existing ? "updated" : "created"}: ${String(agent.agent_id ?? existing)}`);
  console.log("Put this id in anam-overlay/backend/.env as ELEVENLABS_AGENT_ID.");
}

if (process.argv[1]?.endsWith("elevenlabs-agent.ts")) void main().catch((e) => { console.error(String(e)); process.exit(1); });
