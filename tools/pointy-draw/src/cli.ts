/**
 * pointy-draw: dev CLI that posts JSON to the overlay's localhost dev server (spec §8.1).
 * Connection details come from ~/.pointy/dev-server.json, written by the running app.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommand, UsageError, wantsWaitShown, type Request } from "./args";

interface Conn {
  port: number;
  token: string;
}

const CLI_DIR = resolve(fileURLToPath(import.meta.url), "../..");

function connection(): Conn {
  const file = process.env.POINTY_DEV_FILE ?? join(homedir(), ".pointy", "dev-server.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Conn;
  } catch {
    throw new Error(`Pointy dev app is not running (no ${file}). Start it with: npm run dev`);
  }
}

async function call(conn: Conn, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${conn.port}${path}`, {
    method,
    headers: { "x-pointy-token": conn.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/** Resolve a JSON file relative to cwd, then to the CLI package (so examples/... works anywhere). */
function readJsonFile(path: string): unknown {
  const candidates = isAbsolute(path) ? [path] : [resolve(process.cwd(), path), resolve(CLI_DIR, path)];
  for (const c of candidates) {
    try {
      return JSON.parse(readFileSync(c, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  throw new Error(`file not found: ${path}`);
}

interface SseEvent {
  at: number;
  event: { type: string; overlayId?: string };
}

/** Subscribe to /events; returns a stop function. */
async function subscribe(conn: Conn, onEvent: (e: SseEvent) => void): Promise<() => void> {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${conn.port}/events`, { headers: { "x-pointy-token": conn.token }, signal: ctrl.signal });
  if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) onEvent(JSON.parse(line.slice(6)) as SseEvent);
        }
      }
    } catch {
      // aborted
    }
  })();
  return () => ctrl.abort();
}

async function run(argv: string[]): Promise<number> {
  const conn = connection();
  const displays = (await call(conn, "GET", "/displays")) as { primary: string };
  const req: Request = parseCommand(argv, { primaryDisplayId: displays.primary, readJsonFile });

  switch (req.kind) {
    case "get":
      if (req.path === "/events") {
        await subscribe(conn, (e) => console.log(JSON.stringify(e)));
        await new Promise(() => {}); // stream until Ctrl-C
      }
      console.log(JSON.stringify(await call(conn, "GET", req.path), null, 2));
      return 0;
    case "control":
      console.log(JSON.stringify(await call(conn, "POST", "/control", req.body)));
      return 0;
    case "sim":
      console.log(JSON.stringify(await call(conn, "POST", "/sim", req.body)));
      return 0;
    case "tool": {
      const waitShown = wantsWaitShown(argv);
      let shownAt: number | null = null;
      const wanted: { id?: string | undefined } = {};
      let resolveShown: () => void = () => {};
      const shown = new Promise<void>((r) => (resolveShown = r));
      const stop = waitShown
        ? await subscribe(conn, (e) => {
            if (e.event.type === "overlay.shown" && e.event.overlayId === wanted.id) {
              shownAt = e.at;
              resolveShown();
            }
          })
        : () => {};
      const t0 = Date.now();
      const out = (await call(conn, "POST", "/tool", { name: req.name, input: req.input })) as {
        requestedAt: number;
        result: { ok: boolean; overlayId?: string; visible: boolean };
      };
      wanted.id = out.result.overlayId;
      if (waitShown && wanted.id && out.result.visible) {
        await Promise.race([shown, new Promise((r) => setTimeout(r, 3000))]);
      }
      stop();
      const report: Record<string, unknown> = { result: out.result };
      if (waitShown) report.shownMs = shownAt === null ? null : shownAt - t0;
      console.log(JSON.stringify(report));
      return out.result.ok ? 0 : 1;
    }
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof UsageError ? err.message : `pointy-draw: ${(err as Error).message}`);
    process.exit(2);
  },
);
