/**
 * Live eval of the selection-offer flow with the PRODUCTION pieces (assistant instructions, tool
 * definitions, selectionItems, the [offer] item wording, a [screen] control list), text mode.
 *
 *   npm run app                       # dev app running (npm run app, or POINTY_DEV_PORT/FILE + POINTY_DEV_FILE for this script)
 *   npx tsx scripts/eval-offer.ts <selection dir (selection.json + full.jpg + focus.jpg)> ["question"]
 *
 * (a) selection + [offer], tool_choice none -> expect ONE short question and no tool calls.
 * (b) the question (default "is this a scam email?") -> expect label_parts (warning) + show_explainer verdict.
 * Tool calls are executed against the running overlay. Needs OPENAI_API_KEY in the repo-root .env. Costs a few cents.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportToolDefinitions, type ElementRect } from "@pointy/shared/overlay";
import type { SelectionSnapshotMeta } from "@pointy/shared/context/selection";
import { devCall, readDevConnection } from "@pointy/shared/node/devServerFile";
import { loadRepoEnv } from "@pointy/shared/node/env";
import { snapshotFromFiles } from "../tools/pointy-draw/src/selection";
import { selectionItems } from "../apps/desktop/src/renderer/voice/realtimeEvents";
import { OFFER_TEXT } from "../apps/desktop/src/main/assistant/AssistantController";
import { buildAssistantInstructions } from "../apps/desktop/src/main/assistant/instructions";
import { mintAssistantSecret } from "../apps/desktop/src/main/assistant/secret";

const root = resolve(fileURLToPath(import.meta.url), "../..");
loadRepoEnv(root);
const dirArg = process.argv[2];
if (!dirArg) throw new Error("usage: tsx scripts/eval-offer.ts <selection dir> [question]");
const dir: string = dirArg;
const question = process.argv[3] ?? "is this a scam email?";
const conn = readDevConnection();
const dev = <T = unknown>(method: "GET" | "POST", path: string, body?: unknown) => devCall<T>(conn, method, path, body);

async function main() {
  const rects = await dev<ElementRect[]>("GET", "/element-rects");
  const controls = rects.map((e) => `${e.id} | element | ${e.id.replace(/^fixture\./, "")} | ${Math.round(e.rect.x)},${Math.round(e.rect.y)},${Math.round(e.rect.width)},${Math.round(e.rect.height)}`);
  const screen = `[screen] No new screenshot this turn: the [selection] images above show the user's screen as it was when they selected. The control list below is current; prefer its element ids.\nControls (${controls.length}) as "id | role | label | x,y,w,h" in global points.\nBEGIN CONTROLS\n${controls.join("\n")}\nEND CONTROLS`;
  const meta = JSON.parse(readFileSync(join(dir, "selection.json"), "utf8")) as SelectionSnapshotMeta;
  const sel = snapshotFromFiles(meta, readFileSync(join(dir, "full.jpg")), readFileSync(join(dir, "focus.jpg")));
  const secret = await mintAssistantSecret({ apiKey: process.env.OPENAI_API_KEY, instructions: buildAssistantInstructions(), tools: exportToolDefinitions({ pregeneratedImagePrompts: [] }) });
  console.log(`model ${secret.model}, ${rects.length} elements`);
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${secret.model}`, ["realtime", `openai-insecure-api-key.${secret.value}`]);
  const queue: Record<string, unknown>[] = [];
  let waiter: ((e: Record<string, unknown>) => void) | null = null;
  ws.onmessage = (m) => {
    const ev = JSON.parse(String(m.data)) as Record<string, unknown>;
    if (waiter) { const w = waiter; waiter = null; w(ev); } else queue.push(ev);
  };
  const next = () => new Promise<Record<string, unknown>>((r) => { const q = queue.shift(); if (q) r(q); else waiter = r; });
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error("websocket error")); });
  const send = (e: object) => ws.send(JSON.stringify(e));
  send({ type: "session.update", session: { type: "realtime", output_modalities: ["text"] } });
  const user = (text: string) => ({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  async function response() {
    for (;;) {
      const ev = await next();
      if (ev.type === "error") throw new Error(JSON.stringify(ev.error));
      if (ev.type !== "response.done") continue;
      const out = ((ev.response as { output?: unknown[] }).output ?? []) as Record<string, unknown>[];
      const calls = out.filter((o) => o.type === "function_call") as unknown as { name: string; call_id: string; arguments: string }[];
      const text = out.filter((o) => o.type === "message").flatMap((o) => (o.content as { text?: string; transcript?: string }[]) ?? []).map((c) => c.text ?? c.transcript ?? "").join(" ").trim();
      return { calls, text };
    }
  }

  console.log("\n(a) selection + [offer], tool_choice none");
  for (const e of selectionItems(sel, { maxMessageBytes: 256 * 1024 }).events) send(e);
  send(user(OFFER_TEXT));
  send({ type: "response.create", response: { tool_choice: "none" } });
  const a = await response();
  console.log(`   tool calls: ${a.calls.length ? a.calls.map((c) => c.name).join(",") : "none"}\n   says: ${a.text}`);

  console.log(`\n(b) "${question}"`);
  await dev("POST", "/control", { op: "turnStart", arg: "eval-offer" });
  send(user(screen));
  send(user(question));
  send({ type: "response.create" });
  let text = "";
  for (let round = 0; round < 4; round++) {
    const r = await response();
    text = r.text || text;
    if (r.calls.length === 0) break;
    for (const c of r.calls) {
      const args = JSON.parse(c.arguments || "{}") as unknown;
      const out = await dev<{ result: unknown }>("POST", "/tool", { name: c.name, input: args });
      console.log(`   ${c.name} ${JSON.stringify(args)}\n     -> ${JSON.stringify(out.result)}`);
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: JSON.stringify(out.result) } });
    }
    send({ type: "response.create" });
  }
  console.log(`   says: ${text}`);
  ws.close();
}
main().catch((e: unknown) => { console.error("eval failed:", e); process.exit(1); });
