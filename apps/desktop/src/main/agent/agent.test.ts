import { describe, expect, it } from "vitest";
import { FakeClock } from "../overlay/testing/fakeClock";
import type { ScreenContext } from "../assistant/screenContext";
import { AgentSession, LOOK_AT_SCREEN } from "./AgentSession";
import { ToolBridge } from "./ToolBridge";

const ctx: ScreenContext = { text: "[screen] one button", imageDataUrl: null, imageBytes: 0, displayId: "1", elementIds: [], notes: [] };

function setup(over: { background?: () => boolean } = {}) {
  const clock = new FakeClock();
  const calls: string[] = [];
  let connected = false;
  const anam = {
    startSession: async () => { calls.push("start"); connected = true; },
    endSession: async () => { calls.push("end"); connected = false; },
    talk: async () => undefined,
    interrupt: async () => { calls.push("interrupt"); },
    message: async (text: string) => { calls.push("message:" + text); },
    state: async () => ({ connected, speaking: false, expanded: true }),
  };
  const gestures: boolean[] = [];
  const session = new AgentSession({
    anam, clock, gestures: { setSessionActive: (a) => gestures.push(a) },
    tools: { names: () => ["highlight", "run_on_computer"], run: async (name, args) => ({ ok: true, name, args }) },
    buildContext: async () => ctx, selectionNote: () => "[selection] the Send button", backgroundWork: over.background, idleCloseMs: 1000,
  });
  return { session, clock, calls, gestures, drop: () => { connected = false; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("agent session", () => {
  it("opens the call with the gesture session, and closes both after silence", async () => {
    const { session, clock, calls, gestures } = setup();
    await session.open();
    expect(session.status.get()).toBe("listening");
    expect(calls).toEqual(["start"]);
    expect(gestures).toEqual([true]);
    clock.advance(1000);
    await settle();
    expect(calls).toContain("end");
    expect(session.isOpen()).toBe(false);
    expect(gestures.at(-1)).toBe(false);
  });

  it("stays open while a task runs in the background", async () => {
    const { session, clock } = setup({ background: () => true });
    await session.open();
    clock.advance(5000);
    await settle();
    expect(session.isOpen()).toBe(true);
  });

  it("gives the agent the screen as text when it asks, and passes other tools through", async () => {
    const { session } = setup();
    await session.open();
    expect(session.toolNames()).toEqual(["highlight", "run_on_computer", LOOK_AT_SCREEN]);
    expect(await session.runTool(LOOK_AT_SCREEN, {})).toBe("[screen] one button\n[selection] the Send button");
    expect(await session.runTool("run_on_computer", { request: "x" })).toEqual({ ok: true, name: "run_on_computer", args: { request: "x" } });
  });

  it("delivers a note at once while open, and holds it for the next call while closed", async () => {
    const { session, clock, calls } = setup({ background: () => true });
    session.notify("[execution] finished early");
    expect(calls).toEqual([]);
    await session.open();
    clock.advance(1000);
    await settle();
    expect(calls).toContain("message:[execution] finished early");
    session.notify("[execution] second");
    await settle();
    expect(calls).toContain("message:[execution] second");
  });

  it("follows what is said for status, and interrupts only the speech", async () => {
    const { session, calls } = setup();
    await session.open();
    session.onSpoken({ role: "persona", id: "1", content: "Sure", end: false, interrupted: false });
    expect(session.status.get()).toBe("speaking");
    await session.hotkey();
    expect(calls).toContain("interrupt");
    expect(session.status.get()).toBe("listening");
    session.onSpoken({ role: "user", id: "2", content: "open twitch", end: true, interrupted: false });
    expect(session.status.get()).toBe("thinking");
  });
});

describe("tool bridge", () => {
  it("answers only the token holder, lists the tools, runs one and returns its result as text", async () => {
    const spoken: string[] = [];
    const bridge = new ToolBridge({ toolNames: () => ["look_at_screen"], runTool: async (name) => (name === "look_at_screen" ? "[screen] hi" : { ok: true }),
      onSpoken: (e) => spoken.push(e.role + ":" + e.content), file: null });
    await bridge.start();
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-tool-bridge-token": bridge.tokenForTests() }) =>
      fetch(`http://127.0.0.1:${bridge.port}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    expect((await call("GET", "/tools", undefined, {})).status).toBe(401);
    expect((await call("GET", "/tools", undefined, { "x-tool-bridge-token": bridge.tokenForTests(), origin: "https://evil.example" })).status).toBe(401);
    expect(await (await call("GET", "/tools")).json()).toEqual({ tools: ["look_at_screen"] });
    expect(await (await call("POST", "/tool", { name: "look_at_screen", arguments: {} })).json()).toEqual({ result: "[screen] hi" });
    expect((await call("POST", "/tool", { name: "rm_rf", arguments: {} })).status).toBe(404);
    await call("POST", "/event", { role: "user", id: "1", content: "hello", end: true, interrupted: false });
    expect(spoken).toEqual(["user:hello"]);
    bridge.stop();
  });
});
