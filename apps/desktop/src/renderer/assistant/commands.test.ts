import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../main/assistant/ipc";
import { createCommandHandler, type RtcSession } from "./commands";

function fake() {
  const log: string[] = [];
  let resolve!: (v: { maxMessageBytes?: number }) => void;
  let reject!: (e: Error) => void;
  const session: RtcSession = {
    connect: () => new Promise((res, rej) => ((resolve = res), (reject = rej), void log.push("connect"))),
    close: () => void log.push("close"),
    send: (e) => void log.push(`send:${(e as { type: string }).type}`),
    setMic: (b) => void log.push(`mic:${b}`),
  };
  const out: AssistantMessage[] = [];
  const handle = createCommandHandler(session, (m) => out.push(m));
  return { log, out, handle, resolve: (v: { maxMessageBytes?: number } = {}) => resolve(v), reject: (e: Error) => reject(e) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("assistant command handler", () => {
  it("connects once, reports open with the message limit, and forwards sends only when connected", async () => {
    const f = fake();
    f.handle({ kind: "send", event: { type: "early" } });
    f.handle({ kind: "connect" });
    f.handle({ kind: "connect" });
    f.resolve({ maxMessageBytes: 262144 });
    await tick();
    f.handle({ kind: "send", event: { type: "response.create" } });
    expect(f.log).toEqual(["connect", "mic:true", "send:response.create"]);
    expect(f.out).toEqual([{ kind: "open", maxMessageBytes: 262144 }]);
  });

  it("reports failure and closes", async () => {
    const f = fake();
    f.handle({ kind: "connect" });
    f.reject(new Error("realtime/calls 401"));
    await tick();
    expect(f.out).toEqual([{ kind: "failed", error: "realtime/calls 401" }]);
    expect(f.log).toContain("close");
  });

  it("a connect that finishes after disconnect is discarded", async () => {
    const f = fake();
    f.handle({ kind: "connect" });
    f.handle({ kind: "disconnect" });
    f.resolve();
    await tick();
    expect(f.out).toEqual([]);
    expect(f.log.filter((x) => x === "close").length).toBe(1); // only the disconnect; a stale connect never closes a newer session
  });

  it("a stale connect finishing after a newer connect started does not close the newer session", async () => {
    const f = fake();
    f.handle({ kind: "connect" });
    f.handle({ kind: "disconnect" });
    f.handle({ kind: "connect" }); // B
    const closesBefore = f.log.filter((x) => x === "close").length;
    f.resolve(); // the fake resolves the latest connect (B)
    await tick();
    expect(f.log.filter((x) => x === "close").length).toBe(closesBefore);
    expect(f.out).toEqual([{ kind: "open" }]);
  });

  it("remembers a mic command that arrives before the connection is up", async () => {
    const f = fake();
    f.handle({ kind: "connect" });
    f.handle({ kind: "mic", enabled: false });
    f.resolve();
    await tick();
    expect(f.log.slice(-1)).toEqual(["mic:false"]);
  });
});
