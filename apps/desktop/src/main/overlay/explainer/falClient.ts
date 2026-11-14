/**
 * Client for our explainer-image broker (backend/explainer-broker). Never calls fal.ai directly;
 * the API key never ships in the app.
 *
 * getImage(prompt, styleId?):
 *  1. Local pre-generated assets first (assets/explainers/manifest.json written by
 *     scripts/pregen-demo-images.ts) → { ok:true, source:"asset" }.
 *  2. Otherwise POST {brokerUrl}/explainer/image { prompt, styleId } → { url } | { error },
 *     then fetch the url. The whole request is bounded by `timeoutMs` (default 8000).
 *  3. Images are returned as data URLs (renderer CSP allows only data: images).
 *  Never throws: failures resolve to { ok:false, error }.
 *
 * Manifest format: { "entries": [{ "prompt": string, "styleId": string, "file": string }] }, where
 * `file` is relative to assetsDir. Entries match by exact trimmed prompt + styleId ("default" when
 * styleId is omitted).
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type ImageResult =
  | { ok: true; dataUrl: string; source: "asset" | "broker" }
  | { ok: false; error: "timeout" | "broker_error" | "network" };

export interface ImageSource {
  getImage(prompt: string, styleId?: string): Promise<ImageResult>;
}

export interface FalClientOptions {
  brokerUrl: string;
  assetsDir: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_STYLE_ID = "default";
const DEFAULT_TIMEOUT_MS = 8000;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

interface ManifestEntry {
  prompt: string;
  styleId: string;
  file: string;
}

class BrokerError extends Error {}
class TimeoutError extends Error {}

const FUZZY_MIN = 0.6;
const STOP = new Set("a an the of with and in on at to for from its it is are be by as or".split(" "));
const words = (s: string) =>
  new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));

/** Jaccard similarity of the prompts' content words (0..1). */
export function promptSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / (wa.size + wb.size - inter);
}

export class FalClient implements ImageSource {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Parsed manifest, keyed by its mtime so running `npm run pregen` while the app runs takes effect. */
  private manifest: { mtimeMs: number; entries: Promise<ManifestEntry[]> } | null = null;

  constructor(private readonly opts: FalClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getImage(prompt: string, styleId?: string): Promise<ImageResult> {
    try {
      const trimmed = prompt.trim();
      const style = styleId ?? DEFAULT_STYLE_ID;
      const asset = await this.fromAssets(trimmed, style);
      if (asset) return { ok: true, dataUrl: asset, source: "asset" };
      const dataUrl = await this.fromBroker(trimmed, styleId);
      return { ok: true, dataUrl, source: "broker" };
    } catch (e) {
      if (e instanceof TimeoutError) return { ok: false, error: "timeout" };
      if (e instanceof BrokerError) return { ok: false, error: "broker_error" };
      return { ok: false, error: "network" };
    }
  }

  private async loadManifest(): Promise<ManifestEntry[]> {
    const file = path.join(this.opts.assetsDir, "manifest.json");
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      this.manifest = null; // missing now; re-check next time (never memoise a failure)
      return [];
    }
    if (this.manifest?.mtimeMs !== mtimeMs) {
      const entries = readFile(file, "utf8")
        .then((text) => {
          const parsed: unknown = JSON.parse(text);
          const list = (parsed as { entries?: unknown }).entries;
          if (!Array.isArray(list)) return [];
          return list.filter(
            (e): e is ManifestEntry =>
              typeof e === "object" &&
              e !== null &&
              typeof (e as ManifestEntry).prompt === "string" &&
              typeof (e as ManifestEntry).styleId === "string" &&
              typeof (e as ManifestEntry).file === "string",
          );
        })
        .catch(() => {
          this.manifest = null;
          return [] as ManifestEntry[];
        });
      this.manifest = { mtimeMs, entries };
    }
    return this.manifest?.entries ?? [];
  }

  private async fromAssets(prompt: string, styleId: string): Promise<string | null> {
    const entries = (await this.loadManifest()).filter((e) => e.styleId === styleId);
    // Exact match first; otherwise a conservative fuzzy match so a lightly reworded prompt from a
    // live model still uses the pre-generated image (the demo must not depend on fal responding).
    const entry =
      entries.find((e) => e.prompt.trim() === prompt) ??
      entries
        .map((e) => ({ e, score: promptSimilarity(e.prompt, prompt) }))
        .filter((c) => c.score >= FUZZY_MIN)
        .sort((a, b) => b.score - a.score)[0]?.e;
    if (!entry) return null;
    const root = path.resolve(this.opts.assetsDir);
    const file = path.resolve(root, entry.file);
    if (!file.startsWith(root + path.sep)) return null;
    const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
    if (!mime) return null;
    try {
      const bytes = await readFile(file);
      return `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      return null; // missing asset file: fall through to the broker
    }
  }

  private async fromBroker(prompt: string, styleId: string | undefined): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError());
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.requestBroker(prompt, styleId, controller.signal), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestBroker(prompt: string, styleId: string | undefined, signal: AbortSignal): Promise<string> {
    const base = this.opts.brokerUrl.replace(/\/+$/, "");
    const res = await this.fetchImpl(`${base}/explainer/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(styleId === undefined ? { prompt } : { prompt, styleId }),
      signal,
    });
    if (!res.ok) throw new BrokerError();
    const body = (await res.json()) as { url?: unknown };
    if (typeof body.url !== "string") throw new BrokerError();
    const img = await this.fetchImpl(body.url, { signal });
    if (!img.ok) throw new BrokerError();
    const type = (img.headers.get("content-type") ?? "image/png").split(";")[0]?.trim() ?? "image/png";
    if (!type.startsWith("image/")) throw new BrokerError();
    const bytes = Buffer.from(await img.arrayBuffer());
    return `data:${type};base64,${bytes.toString("base64")}`;
  }
}
