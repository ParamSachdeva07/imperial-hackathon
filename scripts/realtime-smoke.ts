/**
 * Realtime GA shape smoke test (production assistant, T2). Talks to the REAL API over WebSocket with
 * tiny text-only turns (a few cents at most) and prints what the server accepted, so
 * apps/desktop/src/main/assistant/realtimeProtocol.ts is built on verified shapes, not guesses.
 *
 *   npx tsx scripts/realtime-smoke.ts
 *
 * Needs OPENAI_API_KEY in the repo-root .env (never printed). Model: POINTY_REALTIME_MODEL ?? OPENAI_REALTIME_MODEL ?? gpt-realtime-2.1; effort POINTY_REASONING_EFFORT ?? minimal.
 */
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadRepoEnv } from "@pointy/shared/node/env";
import { assistantSessionConfig, realtimeModel, reasoningEffort } from "../apps/desktop/src/main/assistant/realtimeProtocol";

loadRepoEnv(resolve(fileURLToPath(import.meta.url), "../.."));
const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error("OPENAI_API_KEY missing (repo-root .env)");
  process.exit(1);
}
const model = realtimeModel();
const effort = reasoningEffort();

type Ev = { type: string; [k: string]: unknown };
const WS = WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket;
const ws = new WS(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${key}` } });
const events: Ev[] = [];
const waiters: Array<{ pred: (e: Ev) => boolean; resolve: (e: Ev) => void }> = [];
ws.onmessage = (m) => {
  const e = JSON.parse(String(m.data)) as Ev;
  events.push(e);
  for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
};
const send = (e: object) => ws.send(JSON.stringify(e));
function waitFor(pred: (e: Ev) => boolean, ms = 20000, label = "event"): Promise<Ev> {
  const seen = events.find(pred);
  if (seen) return Promise.resolve(seen);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), ms);
    waiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e); } });
  });
}
const results: string[] = [];
const note = (ok: boolean, what: string) => { results.push(`${ok ? "OK  " : "FAIL"} ${what}`); console.log(results.at(-1)); };
const mark = () => events.length;
const since = (n: number) => events.slice(n);
const errorsSince = (n: number) => since(n).filter((e) => e.type === "error").map((e) => (e.error as { message?: string })?.message ?? JSON.stringify(e));

// A real 32x32 solid-red PNG built on the fly.
function makePng(w: number, h: number): string {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => (i % 3 === 0 ? 255 : 0))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
const PNG = makePng(32, 32);

await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("websocket error (auth/model?)")); });
const created = await waitFor((e) => e.type === "session.created");
console.log(`session.created ok, model=${model}`);
void created;

// 1. session.update with the config we intend to use in production.
let n = mark();
send({ type: "session.update", session: assistantSessionConfig({ instructions: "You are a test. Answer in at most 8 words.", tools: [], effort }) });
const upd = await waitFor((e) => e.type === "session.updated" || e.type === "error", 10000, "session.updated");
note(upd.type === "session.updated", "session.update with output_modalities:[text] + audio.input.turn_detection{create_response:false,interrupt_response:false}" + (upd.type === "error" ? ` -> ${errorsSince(n)[0]}` : ""));
if (upd.type === "session.updated") {
  const s = upd.session as { output_modalities?: string[]; audio?: { input?: { turn_detection?: unknown } } };
  console.log("  echoed output_modalities:", JSON.stringify(s.output_modalities), " turn_detection:", JSON.stringify(s.audio?.input?.turn_detection));
  const r = (upd.session as { reasoning?: { effort?: string } }).reasoning;
  note(r?.effort === effort, `session.reasoning.effort echoed as ${JSON.stringify(r)} (asked ${effort})`);
}

// 1b. Effort variants via session.update (field = session.reasoning.effort).
for (const v of ["low", "bogus", effort]) {
  n = mark();
  send({ type: "session.update", session: { type: "realtime", reasoning: { effort: v } } });
  const r = await waitFor((e) => events.indexOf(e) >= n && (e.type === "session.updated" || e.type === "error"), 10000, `effort ${v}`);
  console.log(`  effort=${v} -> ${r.type}${r.type === "error" ? ": " + errorsSince(n)[0] : ""}`);
}

// 1c. A tool call round-trip.
n = mark();
send({ type: "session.update", session: { type: "realtime", tools: [{ type: "function", name: "point_at", description: "Point at a named thing on screen.", parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } }], tool_choice: "required" } });
await waitFor((e) => events.indexOf(e) >= n && (e.type === "session.updated" || e.type === "error"), 10000, "tools");
send({ type: "conversation.item.create", item: { id: "tool_smoke1", type: "message", role: "user", content: [{ type: "input_text", text: "Point at the Save button." }] } });
send({ type: "response.create" });
await waitFor((e) => events.indexOf(e) >= n && e.type === "response.done", 30000, "tool response.done");
const fc = since(n).find((e) => e.type === "response.function_call_arguments.done");
note(!!fc, `tool call emitted (response.function_call_arguments.done, args=${String((fc as { arguments?: string } | undefined)?.arguments)})`);
send({ type: "session.update", session: { type: "realtime", tools: [], tool_choice: "auto" } });
await new Promise((r) => setTimeout(r, 800));
send({ type: "conversation.item.delete", item_id: "tool_smoke1" });
await new Promise((r) => setTimeout(r, 500));

events.length = 0; // earlier probes left an expected error in the log; start the next checks clean

// 2. Text item with an image + response.create; text-only streaming deltas.
n = mark();
send({ type: "conversation.item.create", item: { id: "scr_smoke1", type: "message", role: "user", content: [{ type: "input_text", text: "[screen] Say the single word: pong." }, { type: "input_image", image_url: PNG }] } });
const added = await waitFor((e) => e.type === "conversation.item.added" || e.type === "conversation.item.created" || e.type === "error", 10000, "item added");
note(added.type !== "error", `conversation.item.create with input_image accepted; ack event = ${added.type}${added.type === "error" ? " " + errorsSince(n)[0] : ""}`);
const itemId = (added.item as { id?: string } | undefined)?.id;
note(itemId === "scr_smoke1", `client-chosen item id is kept (got ${String(itemId)}), so items can be deleted by our own ids`);
send({ type: "response.create" });
const done = await waitFor((e) => e.type === "response.done", 30000, "response.done");
const evTypes = [...new Set(since(n).map((e) => e.type))];
console.log("  event types seen:", evTypes.join(", "));
note(evTypes.includes("response.output_text.delta"), "response.output_text.delta streamed (text-only)");
note(!evTypes.some((t) => t.startsWith("response.output_audio")), "no audio output events");
const created2 = since(n).find((e) => e.type === "response.created");
note(typeof (created2?.response as { id?: string })?.id === "string", "response.created carries response.id");
const delta = since(n).find((e) => e.type === "response.output_text.delta");
console.log("  delta keys:", delta ? Object.keys(delta).join(",") : "(none)", " response.done status:", (done.response as { status?: string }).status);

// 3. conversation.item.delete
if (itemId) {
  send({ type: "conversation.item.delete", item_id: itemId });
  const del = await waitFor((e) => e.type === "conversation.item.deleted" || e.type === "error", 10000, "item.deleted");
  note(del.type === "conversation.item.deleted", `conversation.item.delete -> ${del.type}`);
} else note(false, "no item id on conversation.item.added; cannot test delete");

// 4. Audio buffer: input_audio_buffer.committed + item for it (0.3s of silence, manual commit).
// Manual commit is only legal with VAD off; with server_vad the server commits itself on speech_stopped
// (same event, which is what production relies on), so switch VAD off just for this probe.
send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null } } } });
await waitFor((e) => e.type === "session.updated" && events.indexOf(e) > events.length - 3, 5000, "vad off").catch(() => undefined);
await new Promise((r) => setTimeout(r, 500));
n = mark();
const silence = Buffer.alloc(24000 * 2 * 0.3).toString("base64"); // pcm16 24k mono
send({ type: "input_audio_buffer.append", audio: silence });
send({ type: "input_audio_buffer.commit" });
const committed = await waitFor((e) => e.type === "input_audio_buffer.committed" || e.type === "error", 10000, "committed");
note(committed.type === "input_audio_buffer.committed", `input_audio_buffer.committed (keys: ${Object.keys(committed).join(",")})${committed.type === "error" ? " " + errorsSince(n)[0] : ""}`);
await new Promise((r) => setTimeout(r, 1500));
console.log("  events after commit:", [...new Set(since(n).map((e) => e.type))].join(", "));

// 5. response.cancel with nothing active should be a harmless error (documents the behaviour).
n = mark();
send({ type: "response.cancel" });
await new Promise((r) => setTimeout(r, 1200));
console.log("  response.cancel while idle ->", errorsSince(n)[0] ?? "no error");

ws.close();
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : "\nall checks OK");
process.exit(failed.length ? 1 : 0);
