import { describe, expect, it } from "vitest";
import type { ExecutionPort, TaskReport } from "./ExecutionClient";
import { EXECUTION_TOOLS, ExecutionToolHost, executionNote } from "./ExecutionTools";

const report = (over: Partial<TaskReport> = {}): TaskReport => ({
  taskId: "t1", status: "executing", busy: true, step: 2, plan: [{ text: "Open Twitch", status: "todo" }], completion: null, goal: "open twitch", message: "Clicking", ...over,
});
const done = (taskId: string, status = "completed", summary = "Twitch is open."): TaskReport =>
  report({ taskId, status, busy: false, completion: { summary, facts: ['heading "Twitch"'], location: { app: "Google Chrome", window: "Twitch", address: "https://www.twitch.tv/" } } });

function setup() {
  const started: { goal: string; context: string }[] = [];
  let push: (r: TaskReport) => void = () => undefined;
  let stops = 0;
  let current: TaskReport | null = null;
  const client: ExecutionPort = {
    start: async (goal, context) => { started.push({ goal, context }); return "t" + started.length; },
    stop: async () => { stops++; },
    state: async () => current,
    watch: (cb) => { push = cb; return () => { push = () => undefined; }; },
  };
  const notes: string[] = [];
  const events: string[] = [];
  const host = new ExecutionToolHost({ client, announce: (t) => notes.push(t), onTaskStart: () => events.push("start"), onTaskEnd: () => events.push("end") });
  return { host, started, notes, events, emit: (r: TaskReport) => { current = r; push(r); }, stops: () => stops };
}

describe("the execution tool", () => {
  it("returns at once and announces the outcome later, with where the computer was left", async () => {
    const { host, started, notes, events, emit } = setup();
    const result = (await host.handle("run_on_computer", { request: "open twitch", context: "" })) as { started: boolean; taskId: string };
    expect(result).toMatchObject({ ok: true, started: true, taskId: "t1" });
    expect(started).toEqual([{ goal: "open twitch", context: "" }]);
    expect(notes).toEqual([]);
    expect(host.isRunning()).toBe(true);
    emit(report());
    expect(notes).toEqual([]);
    emit(done("t1"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^\[execution\] The task "open twitch" finished\. Twitch is open\./);
    expect(notes[0]).toContain("Google Chrome / Twitch / https://www.twitch.tv/");
    expect(events).toEqual(["start", "end"]);
    expect(host.isRunning()).toBe(false);
  });

  it("passes on the context the voice agent chose, and a new request replaces the running task", async () => {
    const { host, started, notes, events, emit } = setup();
    await host.handle("run_on_computer", { request: "open twitch", context: "" });
    const second = (await host.handle("run_on_computer", { request: "open the first stream", context: "Twitch is already open in Chrome." })) as { note: string };
    expect(second.note).toContain("replaced");
    expect(started[1]).toEqual({ goal: "open the first stream", context: "Twitch is already open in Chrome." });
    emit(done("t1", "cancelled", ""));
    expect(notes).toEqual([]); // the replaced task's ending is not reported
    emit(done("t2"));
    expect(notes).toHaveLength(1);
    expect(events).toEqual(["start", "end"]);
  });

  it("reports failure as plainly as success, so it can be context for the next task", () => {
    expect(executionNote(done("t1", "blocked", "The site needs a sign-in code."))).toContain("could not be done. The site needs a sign-in code.");
    expect(executionNote(done("t1", "completed_unverified"))).toContain("could not be confirmed on screen");
  });

  it("stops the task, answers status questions, and refuses a request with no words", async () => {
    const { host, emit, stops } = setup();
    expect(await host.handle("stop_computer_task", {})).toMatchObject({ stopped: false });
    expect(await host.handle("computer_task_status", {})).toMatchObject({ running: false });
    expect(await host.handle("run_on_computer", { request: " " })).toMatchObject({ ok: false });
    await host.handle("run_on_computer", { request: "open twitch", context: "" });
    emit(report());
    expect(await host.handle("computer_task_status", {})).toMatchObject({ running: true, task: "open twitch", steps: 2, latest: "Clicking" });
    expect(await host.handle("stop_computer_task", {})).toMatchObject({ stopped: true });
    expect(stops()).toBe(1);
  });

  it("offers three tools with strict schemas", () => {
    expect(EXECUTION_TOOLS.map((t) => t.name)).toEqual(["run_on_computer", "stop_computer_task", "computer_task_status"]);
    expect(EXECUTION_TOOLS.every((t) => t.parameters.additionalProperties === false)).toBe(true);
  });
});
