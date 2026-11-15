import { describe, expect, it } from "vitest";
import type { AssistantCommand, AssistantMessage } from "./ipc";
import { RendererTransport } from "./rendererTransport";

function setup() {
  const sent: AssistantCommand[] = [];
  let cb: (m: AssistantMessage) => void = () => {};
  const timers: Array<() => void> = [];
  const t = new RendererTransport({
    channel: { send: (c) => void sent.push(c), onMessage: (f) => ((cb = f), () => {}) },
    setTimeout: (fn) => (timers.push(fn), timers.length),
    clearTimeout: () => {},
  });
  return { t, sent, recv: (m: AssistantMessage) => cb(m), timers };
}

describe("RendererTransport", () => {
  it("connect resolves on open and exposes the message limit; send only when open", async () => {
    const { t, sent, recv } = setup();
    t.send({ type: "early" });
    const p = t.connect();
    expect(sent).toEqual([{ kind: "connect" }]);
    recv({ kind: "open", maxMessageBytes: 1000 });
    await p;
    expect(t.maxMessageBytes()).toBe(1000);
    t.send({ type: "response.create" });
    t.setMicEnabled(false);
    expect(sent.slice(1)).toEqual([{ kind: "send", event: { type: "response.create" } }, { kind: "mic", enabled: false }]);
  });

  it("rejects on failure and on timeout", async () => {
    const a = setup();
    const p = a.t.connect();
    a.recv({ kind: "failed", error: "401" });
    await expect(p).rejects.toThrow("401");
    const b = setup();
    const q = b.t.connect();
    b.timers[0]?.();
    await expect(q).rejects.toThrow("timed out");
    expect(b.sent.at(-1)).toEqual({ kind: "disconnect" });
  });

  it("forwards server events and reports a drop only after it was open", async () => {
    const { t, recv } = setup();
    const events: string[] = [];
    const closes: string[] = [];
    t.onEvent((e) => events.push(e.type));
    t.onClosed((r) => closes.push(r));
    recv({ kind: "closed", reason: "early" });
    const p = t.connect();
    recv({ kind: "open" });
    await p;
    recv({ kind: "server", event: { type: "response.created" } });
    recv({ kind: "closed", reason: "pc failed" });
    expect(events).toEqual(["response.created"]);
    expect(closes).toEqual(["pc failed"]);
  });

  it("disconnect rejects a pending connect and tells the renderer", async () => {
    const { t, sent } = setup();
    const p = t.connect();
    t.disconnect();
    await expect(p).rejects.toThrow();
    expect(sent.at(-1)).toEqual({ kind: "disconnect" });
  });
});
