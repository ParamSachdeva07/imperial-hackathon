/** Tiny JSON-over-HTTP helpers for the localhost servers (dev server, explainer broker). */
import type { IncomingMessage, ServerResponse } from "node:http";

export class BodyTooLarge extends Error {}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Read a JSON body up to `maxBytes` (BodyTooLarge beyond it, SyntaxError if not JSON; empty → {}). */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export const isJsonRequest = (req: IncomingMessage): boolean =>
  (req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");

/**
 * Only answer requests addressed to localhost. Blocks DNS-rebinding pages, which can otherwise reach
 * a 127.0.0.1 server under their own origin and send "simple" requests without a CORS preflight.
 */
export function isLocalHostHeader(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost";
}
