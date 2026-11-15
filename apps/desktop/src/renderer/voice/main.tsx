/**
 * DEV-ONLY GPT Realtime test window: talk to Pointy and watch it call the overlay tools.
 * WebRTC flow (verified against OpenAI docs, Nov 2026): ephemeral secret from main →
 * POST https://api.openai.com/v1/realtime/calls (application/sdp) → data channel "oai-events".
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { OverlayEvent, ToolResult } from "@pointy/shared/overlay/schemas";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import { handleServerEvent, selectionItems } from "./realtimeEvents";
import "./voice.css";

interface VoiceApi {
  getSecret(): Promise<{ value: string; expiresAt: number; model: string }>;
  callTool(name: string, args: unknown): Promise<ToolResult>;
  turnStart(turnId: string): Promise<void>;
  instructions(): Promise<string>;
  openFixture(): Promise<number>;
  onOverlayEvent(cb: (e: OverlayEvent) => void): () => void;
  onSelection(cb: (s: SelectionSnapshot) => void): () => void;
  latestSelection(): Promise<SelectionSnapshot | null>;
}
const voice = (window as unknown as { pointyVoice: VoiceApi }).pointyVoice;

type Line = { kind: "you" | "pointy" | "tool" | "error" | "info" | "event"; text: string; at: number };
type Status = "idle" | "connecting" | "live" | "error";

function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const pc = useRef<RTCPeerConnection | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const turn = useRef(0);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const lastSentSelection = useRef<string | null>(null);
  const logEnd = useRef<HTMLDivElement | null>(null);

  const log = (kind: Line["kind"], text: string) => setLines((l) => [...l.slice(-200), { kind, text, at: Date.now() }]);

  useEffect(() => {
    const off = voice.onOverlayEvent((e) => log("event", JSON.stringify(e)));
    return () => off();
  }, []);
  function deliverSelection(s: SelectionSnapshot) {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") {
      // Not held here: main keeps the session-bound latest and we pull it when the channel opens.
      log("info", "selection received; will send once connected");
      return;
    }
    if (lastSentSelection.current === s.id) return;
    const max = pc.current?.sctp?.maxMessageSize;
    const { events, note } = selectionItems(s, { maxMessageBytes: max && Number.isFinite(max) ? max : undefined });
    try {
      for (const e of events) dc.send(JSON.stringify(e));
    } catch (err) {
      log("error", `selection send failed (will retry on the next connection): ${String(err)}`);
      return;
    }
    lastSentSelection.current = s.id;
    log("info", `selection sent: ${note}`);
  }
  const deliverRef = useRef(deliverSelection);
  deliverRef.current = deliverSelection;
  useEffect(() => voice.onSelection((s) => deliverRef.current(s)), []);
  useEffect(() => {
    // Block body on purpose: newer Chromium returns a Promise from scrollIntoView, and an effect
    // must never return anything but a cleanup function.
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  async function connect() {
    setStatus("connecting");
    try {
      const secret = await voice.getSecret();
      log("info", `model ${secret.model}`);
      const conn = new RTCPeerConnection();
      pc.current = conn;
      conn.ontrack = (e) => {
        if (audio.current) audio.current.srcObject = e.streams[0] ?? null;
      };
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of mic.getTracks()) conn.addTrack(track, mic);
      const dc = conn.createDataChannel("oai-events");
      dcRef.current = dc;
      const deps = {
        send: (e: object) => dc.readyState === "open" && dc.send(JSON.stringify(e)),
        callTool: (name: string, args: unknown) => voice.callTool(name, args),
        turnStart: (id: string) => voice.turnStart(id),
        instructions: () => voice.instructions(),
        log,
        newTurnId: () => `voice-turn-${++turn.current}`,
      };
      dc.onmessage = (m) => {
        try {
          void handleServerEvent(JSON.parse(String(m.data)) as { type: string }, deps);
        } catch (e) {
          log("error", String(e));
        }
      };
      dc.onopen = () => {
        setStatus("live");
        // Make sure the AI knows what's on screen right now.
        void voice.instructions().then((instructions) =>
          deps.send({ type: "session.update", session: { type: "realtime", instructions } }),
        );
        void voice.latestSelection().then((queued) => {
          if (queued) deliverRef.current(queued);
        });
        log("info", "connected — say something like “where is the Send button?”");
      };
      await conn.setLocalDescription(await conn.createOffer());
      await waitForIce(conn);
      const res = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { authorization: `Bearer ${secret.value}`, "content-type": "application/sdp" },
        body: conn.localDescription?.sdp ?? "",
      });
      if (!res.ok) throw new Error(`realtime/calls ${res.status}: ${await res.text()}`);
      await conn.setRemoteDescription({ type: "answer", sdp: await res.text() });
    } catch (e) {
      log("error", String(e));
      setStatus("error");
      disconnect();
    }
  }

  function disconnect() {
    const conn = pc.current;
    pc.current = null;
    dcRef.current = null;
    lastSentSelection.current = null; // a new connection is a new conversation: it needs the image again
    if (conn) {
      for (const s of conn.getSenders()) s.track?.stop();
      conn.close();
    }
    setStatus((s) => (s === "error" ? s : "idle"));
  }

  async function openFixture() {
    const n = await voice.openFixture();
    log("info", `test app open — the AI can point at ${n} controls`);
  }

  async function clearAll() {
    log("tool", `clear(all) → ${JSON.stringify(await voice.callTool("clear", { overlayId: "all" }))}`);
  }

  return (
    <main>
      <header>
        <h1>Pointy voice test</h1>
        <span className={`status status-${status}`}>{status}</span>
      </header>
      <div className="actions">
        {status === "live" || status === "connecting" ? (
          <button onClick={disconnect}>Stop</button>
        ) : (
          <button className="primary" onClick={() => void connect()}>
            Start talking
          </button>
        )}
        <button onClick={() => void openFixture()}>Open test app</button>
        <button onClick={() => void clearAll()}>Clear overlay</button>
      </div>
      <section className="log">
        {lines.map((l, i) => (
          <p key={i} className={`line line-${l.kind}`}>
            <b>{l.kind}</b> {l.text}
          </p>
        ))}
        <div ref={logEnd} />
      </section>
      <audio ref={audio} autoPlay />
    </main>
  );
}

function waitForIce(conn: RTCPeerConnection): Promise<void> {
  if (conn.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (conn.iceGatheringState === "complete") {
        conn.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    conn.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, 2000); // don't hang on slow ICE; send what we have
  });
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
