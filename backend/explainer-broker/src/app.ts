import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { type ImageService } from "./imageService.js";

export const MAX_BODY_BYTES = 8 * 1024;

export const ImageRequest = z.object({
  prompt: z.string().trim().min(1).max(300),
  styleId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
});

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createBrokerServer(service: ImageService, getBaseUrl: () => string): Server {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/explainer/image") {
      if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return send(res, 415, { error: "content-type must be application/json" });
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e instanceof BodyTooLarge) {
          res.setHeader("connection", "close");
          return send(res, 413, { error: "body too large" });
        }
        throw e;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
      const parsed = ImageRequest.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: "invalid request: prompt (1-300 chars) required" });
      try {
        const file = await service.getImageFile(parsed.data.prompt, parsed.data.styleId);
        return send(res, 200, { url: `${getBaseUrl()}/explainer/files/${file}` });
      } catch {
        return send(res, 502, { error: "image generation failed" });
      }
    }

    if (req.method === "GET" && url.pathname.startsWith("/explainer/files/")) {
      const name = url.pathname.slice("/explainer/files/".length);
      const file = await service.readFile(name); // validates the name against a strict regex
      if (!file) return send(res, 404, { error: "not found" });
      res.writeHead(200, {
        "content-type": file.contentType,
        "content-length": file.bytes.length,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      res.end(file.bytes);
      return;
    }

    send(res, 404, { error: "not found" });
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
      else res.end();
    });
  });
}
