/**
 * Where the dev app publishes its localhost dev-server connection ({ port, token }) for the
 * `pointy-draw` CLI and the scripts. POINTY_DEV_FILE overrides it (isolated test runs).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DEV_PORT = 47615;
export const DEV_TOKEN_HEADER = "x-pointy-token";

export function devServerFile(): string {
  return process.env.POINTY_DEV_FILE ?? join(homedir(), ".pointy", "dev-server.json");
}

export interface DevConnection {
  port: number;
  token: string;
}

/** Read the running dev app's connection; throws a friendly error when it isn't running. */
export function readDevConnection(): DevConnection {
  const file = devServerFile();
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DevConnection;
  } catch {
    throw new Error(`Pointy dev app is not running (no ${file}). Start it with: npm run app`);
  }
}

/** Call the dev server (JSON in/out, token header). Throws on non-2xx with the server's message. */
export async function devCall<T = unknown>(conn: DevConnection, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${conn.port}${path}`, {
    method,
    headers: { [DEV_TOKEN_HEADER]: conn.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json()) as T;
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data)}`);
  return data;
}
