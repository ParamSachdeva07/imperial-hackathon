import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Appended verbatim to EVERY prompt (spec 2.3 / 7.3): image models must never render words. */
export const STYLE_SUFFIX =
  "flat vector illustration, thick dark outlines, high contrast, large simple friendly shapes, warm colours, plain light background, centred subject, no text, no letters, no words, no numbers";

export const DEFAULT_STYLE_ID = "default";

export function buildPrompt(prompt: string): string {
  return `${prompt.trim()}, ${STYLE_SUFFIX}`;
}

export function cacheKey(modelId: string, prompt: string, styleId: string): string {
  return createHash("sha256")
    .update(modelId + prompt + styleId)
    .digest("hex");
}

/** Calls fal (or a mock). Receives the full prompt including the style suffix. */
export type GenerateFn = (fullPrompt: string) => Promise<{ url: string }>;
export type DownloadFn = (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;

export interface ImageServiceOptions {
  modelId: string;
  cacheDir: string;
  generate: GenerateFn;
  download: DownloadFn;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
export const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};
export const FILE_NAME_RE = /^[a-f0-9]{64}\.(png|jpg|webp)$/;

export class ImageService {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly opts: ImageServiceOptions) {}

  /** Returns the cached file name (`<key>.<ext>`), generating it if needed. */
  getImageFile(prompt: string, styleId: string = DEFAULT_STYLE_ID): Promise<string> {
    const key = cacheKey(this.opts.modelId, prompt, styleId);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.resolve(key, prompt).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Absolute path for a validated file name, or null if the name is not a legal cache file. */
  filePath(name: string): string | null {
    if (!FILE_NAME_RE.test(name)) return null;
    return path.join(this.opts.cacheDir, name);
  }

  async readFile(name: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const p = this.filePath(name);
    if (!p) return null;
    try {
      const bytes = await readFile(p);
      const ext = name.split(".")[1] ?? "";
      return { bytes, contentType: CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }

  private async resolve(key: string, prompt: string): Promise<string> {
    await mkdir(this.opts.cacheDir, { recursive: true });
    const hit = (await readdir(this.opts.cacheDir)).find((f) => f.startsWith(`${key}.`) && FILE_NAME_RE.test(f));
    if (hit) return hit;
    const { url } = await this.opts.generate(buildPrompt(prompt));
    const { bytes, contentType } = await this.opts.download(url);
    const ext = EXT_BY_TYPE[contentType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "png";
    const name = `${key}.${ext}`;
    const tmp = path.join(this.opts.cacheDir, `${name}.tmp-${process.pid}-${Date.now()}`);
    await writeFile(tmp, bytes);
    await rename(tmp, path.join(this.opts.cacheDir, name));
    return name;
  }
}
