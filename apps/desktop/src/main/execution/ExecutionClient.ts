/**
 * Client for the execution agent's local service (execution/apps/desktop/electron/service.ts):
 *   POST /task {goal, context?} -> {taskId}   POST /stop   GET /state   GET /events (server-sent reports)
 * Discovery: a 0600 file with {port, token, pid}. No electron import.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TaskReport {
  taskId: string | null;
  /** completed | completed_unverified | blocked | cancelled | failed, or a running state. */
  status: string;
  busy: boolean;
  step: number;
  plan: { text: string; status: string }[];
  completion: { summary: string; facts: string[]; location: { app: string; window: string; address: string } } | null;
  goal: string;
  message: string;
}

/** What the execution tool needs from the service (faked in tests). */
export interface ExecutionPort {
  start(goal: string, context: string): Promise<string>;
  stop(): Promise<void>;
  state(): Promise<TaskReport | null>;
  /** Calls back with every report until the returned function is called. */
  watch(onReport: (r: TaskReport) => void): () => void;
}

export const executionServiceFile = (): string =>
  process.env.EXECUTION_SERVICE_FILE || join(homedir(), ".execution-agent", "service.json");

export class ExecutionUnavailable extends Error {}

export class ExecutionClient implements ExecutionPort {
  constructor(
    private readonly opts: { file?: string; fetch?: typeof fetch; readFile?: (path: string) => string } = {},
  ) {}

  private connection(): { url: string; headers: Record<string, string> } {
    try {
      const j = JSON.parse((this.opts.readFile ?? ((p) => readFileSync(p, "utf8")))(this.opts.file ?? executionServiceFile())) as { port?: unknown; token?: unknown };
      if (typeof j.port !== "number" || typeof j.token !== "string") throw new Error("bad file");
      return { url: `http://127.0.0.1:${j.port}`, headers: { authorization: `Bearer ${j.token}`, "content-type": "application/json" } };
    } catch {
      throw new ExecutionUnavailable("The execution agent is not running (start it with `npm run serve` in execution/).");
    }
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const { url, headers } = this.connection();
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new ExecutionUnavailable("The execution agent did not answer.");
    }
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new Error(data?.error ?? `execution agent ${path} -> ${res.status}`);
    return data;
  }

  async start(goal: string, context: string): Promise<string> {
    const r = (await this.call("POST", "/task", { goal, context })) as { taskId?: string };
    if (!r?.taskId) throw new Error("The execution agent returned no task id.");
    return r.taskId;
  }

  async stop(): Promise<void> {
    await this.call("POST", "/stop");
  }

  async state(): Promise<TaskReport | null> {
    try {
      return (await this.call("GET", "/state")) as TaskReport;
    } catch {
      return null;
    }
  }

  watch(onReport: (r: TaskReport) => void): () => void {
    const abort = new AbortController();
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const { url, headers } = this.connection();
          const res = await (this.opts.fetch ?? fetch)(url + "/events", { headers, signal: abort.signal });
          const reader = res.body?.getReader();
          if (!res.ok || !reader) throw new Error("no stream");
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let at: number;
            while ((at = buffer.indexOf("\n\n")) >= 0) {
              const line = buffer.slice(0, at).replace(/^data: /, "");
              buffer = buffer.slice(at + 2);
              try {
                onReport(JSON.parse(line) as TaskReport);
              } catch {
                /* a partial or foreign line: skip it */
              }
            }
          }
        } catch {
          /* the service is down or restarting: try again shortly */
        }
        if (!abort.signal.aborted) await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    return () => abort.abort();
  }
}
