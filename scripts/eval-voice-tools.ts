/**
 * Live tool-choice eval for the voice harness (spec phase 7: "the AI picks sensible tools").
 * Sends typed requests to the REAL GPT Realtime model (text mode, same instructions + tools as the
 * voice window), executes every tool call against the RUNNING overlay via the dev server, and
 * reports what the model drew.
 *
 *   npm run app            # in another terminal (overlay + fake mail app must be running)
 *   npx tsx scripts/eval-voice-tools.ts ["custom request" ...]
 *
 * Needs OPENAI_API_KEY in the repo-root .env. Dev-only.
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DisplayInfo, ElementRect } from "@pointy/shared/overlay";
import { devCall, readDevConnection } from "@pointy/shared/node/devServerFile";
import { delay, loadRepoEnv } from "@pointy/shared/node/env";
import { readManifestPrompts } from "../apps/desktop/src/main/overlay/explainer/manifest";
import { mintClientSecret, REALTIME_MODEL, type HarnessContext } from "../apps/desktop/src/dev/realtime/realtimeSession";

const root = resolve(fileURLToPath(import.meta.url), "../..");
loadRepoEnv(root);
const conn = readDevConnection();
const dev = <T = unknown>(method: "GET" | "POST", path: string, body?: unknown) => devCall<T>(conn, method, path, body);

const REQUESTS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "Where is the Send button?",
      "Is the link in this email safe?",
      "How do I write a new email? Show me step by step.",
      "What are all these buttons at the top of the window?",
      "What is the cloud?",
      "Can you point at the attach button?",
      "Is this email a scam? Show me how a real email differs from a scam one.",
      "The bubble is in my way, can you move it to the other corner?",
      "Okay, got it, thanks.",
    ];

interface Call {
  name: string;
  args: unknown;
  result: unknown;
}

async function main() {
  // Same context the voice window uses: live element list from the running app.
  if ((await dev<string[]>("GET", "/elements")).length === 0) {
    console.log("No on-screen elements — opening the fake mail app first.");
    await dev("POST", "/fixture", {});
  }
  const elements = await dev<ElementRect[]>("GET", "/element-rects");
  const state = await dev<{ primary: string; displays: DisplayInfo[] }>("GET", "/displays");
  const imagePrompts = await readManifestPrompts(join(root, "assets/explainers"));
  const ctx: HarnessContext = {
    listElements: () => elements,
    getDisplays: () => state.displays,
    primaryDisplayId: () => state.primary,
    pregeneratedImagePrompts: async () => imagePrompts,
  };
  const secret = await mintClientSecret(process.env.OPENAI_API_KEY!, ctx);
  console.log(`model ${secret.model}, ${elements.length} on-screen elements\n`);

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, [
    "realtime",
    `openai-insecure-api-key.${secret.value}`,
  ]);
  const queue: Record<string, unknown>[] = [];
  let waiter: ((e: Record<string, unknown>) => void) | null = null;
  ws.onmessage = (m) => {
    const ev = JSON.parse(String(m.data)) as Record<string, unknown>;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(ev);
    } else queue.push(ev);
  };
  const next = () =>
    new Promise<Record<string, unknown>>((r) => {
      const q = queue.shift();
      if (q) r(q);
      else waiter = r;
    });
  await new Promise<void>((r, j) => {
    ws.onopen = () => r();
    ws.onerror = (e) => j(new Error(`websocket error: ${String((e as ErrorEvent).message ?? e)}`));
  });
  const send = (e: object) => ws.send(JSON.stringify(e));
  send({ type: "session.update", session: { type: "realtime", output_modalities: ["text"] } });

  /** Wait for response.done; returns its function calls and text. */
  async function awaitResponse(): Promise<{ calls: { name: string; call_id: string; arguments: string }[]; text: string }> {
    for (;;) {
      const ev = await next();
      if (ev.type === "error") throw new Error(JSON.stringify(ev.error));
      if (ev.type !== "response.done") continue;
      const output = ((ev.response as { output?: unknown[] }).output ?? []) as Record<string, unknown>[];
      const calls = output.filter((o) => o.type === "function_call") as unknown as { name: string; call_id: string; arguments: string }[];
      const text = output
        .filter((o) => o.type === "message")
        .flatMap((o) => (o.content as { text?: string; transcript?: string }[]) ?? [])
        .map((c) => c.text ?? c.transcript ?? "")
        .join(" ")
        .trim();
      return { calls, text };
    }
  }

  let drawnTurns = 0;
  for (const [i, request] of REQUESTS.entries()) {
    await dev("POST", "/control", { op: "turnStart", arg: `eval-${i}` });
    send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: request }] } });
    send({ type: "response.create" });
    const calls: Call[] = [];
    let text = "";
    for (let round = 0; round < 4; round++) {
      const r = await awaitResponse();
      text = r.text || text;
      if (r.calls.length === 0) break;
      for (const c of r.calls) {
        let args: unknown;
        try {
          args = JSON.parse(c.arguments || "{}");
        } catch {
          args = c.arguments;
        }
        const out = await dev<{ result: unknown }>("POST", "/tool", { name: c.name, input: args });
        calls.push({ name: c.name, args, result: out.result });
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: JSON.stringify(out.result) } });
      }
      send({ type: "response.create" });
    }
    const drew = calls.some((c) => (c.result as { visible?: boolean }).visible);
    if (drew) drawnTurns += 1;
    console.log(`▶ "${request}"`);
    for (const c of calls) {
      const res = c.result as { ok?: boolean; visible?: boolean; reason?: string; overlayId?: string };
      console.log(`   ${c.name} ${JSON.stringify(c.args)}\n     → ok=${res.ok} visible=${res.visible}${res.reason ? ` reason=${res.reason}` : ""}${res.overlayId ? ` id=${res.overlayId}` : ""}`);
    }
    if (calls.length === 0) console.log("   (no tool call)");
    console.log(`   says: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}\n`);
    await delay(2500); // leave it on screen briefly
  }
  ws.close();
  console.log(`${drawnTurns}/${REQUESTS.length} requests drew something visible.`);
}

main().catch((e: unknown) => {
  console.error("eval failed:", e);
  process.exit(1);
});
