/**
 * The execution tool: the voice agent hands a request to the execution agent and keeps talking.
 * A call returns at once; the outcome arrives later as one "[execution]" note the agent then reports.
 * The voice agent chooses what earlier context to pass along; this file never decides relevance.
 * No electron import.
 */
import type { ExecutionPort, TaskReport } from "./ExecutionClient";

export interface ExecutionToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const EXECUTION_TOOLS: ExecutionToolDefinition[] = [
  {
    type: "function",
    name: "run_on_computer",
    description:
      "Do something on the user's computer for them: open apps and sites, click, type, search, fill in, send. Use it only when the user asks you to DO something, not when they ask where something is or how to do it. It returns at once and the work continues in the background; you are told the outcome later in an [execution] message. Only one task runs at a time: calling this again replaces the running task.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["request", "context"],
      properties: {
        request: { type: "string", description: "What to do, in plain words, with every name, text and choice the user gave. If they pointed at or selected something, say what it is." },
        context: { type: "string", description: "Anything from earlier in this conversation that this task depends on: what an earlier task did or where it failed, where things were left. Empty when nothing earlier matters." },
      },
    },
  },
  {
    type: "function",
    name: "stop_computer_task",
    description: "Stop the task that is running on the computer. Use it when the user says stop, cancel, wait or never mind about what is being done.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    type: "function",
    name: "computer_task_status",
    description: "What the running or last task on the computer is doing or how it ended. Use it when the user asks how it is going.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
];

const EXECUTION_TOOL_NAMES = new Set(EXECUTION_TOOLS.map((t) => t.name));
const ENDINGS: Record<string, string> = {
  completed: "finished",
  completed_unverified: "was carried out, but the result could not be confirmed on screen",
  blocked: "could not be done",
  cancelled: "was stopped",
  failed: "failed",
};

/** The one line of text the voice agent receives when a task ends. Pure. */
export function executionNote(r: TaskReport): string {
  const c = r.completion;
  const where = c ? [c.location.app, c.location.window, c.location.address].filter(Boolean).join(" / ") : "";
  return (
    `[execution] The task "${r.goal}" ${ENDINGS[r.status] ?? r.status}.` +
    (c?.summary ? ` ${c.summary}` : r.message ? ` ${r.message}` : "") +
    (c?.facts.length ? ` Seen on screen: ${c.facts.slice(0, 6).join("; ")}.` : "") +
    (where ? ` The computer was left at: ${where}.` : "") +
    " Tell the user the outcome in one or two short sentences. This is a report, not a new request: do not start another task because of it."
  );
}

export interface ExecutionToolDeps {
  client: ExecutionPort;
  /** Put a note into the conversation and have the agent speak about it. */
  announce(text: string): void;
  /** A task began: clear drawings, stop the hand from driving the mouse. */
  onTaskStart?(): void;
  /** No task is running any more. */
  onTaskEnd?(): void;
  log?(msg: string): void;
}

export class ExecutionToolHost {
  private running: string | null = null;
  private last: TaskReport | null = null;
  private unwatch: (() => void) | null = null;

  constructor(private readonly deps: ExecutionToolDeps) {}

  handles(name: string): boolean {
    return EXECUTION_TOOL_NAMES.has(name);
  }
  isRunning(): boolean {
    return this.running !== null;
  }

  async handle(name: string, args: unknown): Promise<unknown> {
    try {
      if (name === "run_on_computer") {
        const a = (args ?? {}) as { request?: unknown; context?: unknown };
        if (typeof a.request !== "string" || !a.request.trim()) return { ok: false, error: "request is required" };
        const replaced = this.running !== null;
        // Watch before starting, so a task that ends at once is not missed.
        this.unwatch ??= this.deps.client.watch((r) => this.onReport(r));
        const taskId = await this.deps.client.start(a.request.trim().slice(0, 1000), typeof a.context === "string" ? a.context.slice(0, 2000) : "");
        this.running = taskId;
        if (!replaced) this.deps.onTaskStart?.();
        this.deps.log?.(`execution started ${taskId}${replaced ? " (replaced the running task)" : ""}`);
        return { ok: true, started: true, taskId, note: "Running in the background. Say briefly that you are on it; you will get an [execution] message when it ends." + (replaced ? " The task that was running was replaced." : "") };
      }
      if (name === "stop_computer_task") {
        if (!this.running) return { ok: true, stopped: false, note: "Nothing was running." };
        await this.deps.client.stop();
        return { ok: true, stopped: true };
      }
      const r = (await this.deps.client.state()) ?? this.last;
      if (!r || !r.taskId) return { ok: true, running: false, note: "No task has been run yet." };
      return { ok: true, running: r.busy, task: r.goal, status: r.status, steps: r.step, plan: r.plan, latest: r.message, result: r.busy ? undefined : r.completion };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Stop watching and stop any running task (the assistant closed). */
  dispose(): void {
    this.unwatch?.();
    this.unwatch = null;
    if (this.running) void this.deps.client.stop().catch(() => undefined);
    this.finish();
  }

  private onReport(r: TaskReport): void {
    if (!this.running || r.taskId !== this.running) return; // a replaced task's last words, or another caller's task
    this.last = r;
    if (r.busy) return;
    this.deps.log?.(`execution ended ${r.taskId}: ${r.status}`);
    this.finish();
    this.deps.announce(executionNote(r));
  }

  private finish(): void {
    if (!this.running) return;
    this.running = null;
    this.deps.onTaskEnd?.();
  }
}
