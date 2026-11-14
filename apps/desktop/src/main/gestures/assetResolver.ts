/**
 * Pure (no electron import) request resolution for the gesture asset scheme: maps
 * `pointy-gestures-assets://assets/<mediapipe-wasm|models>/<file>` onto files under one root dir
 * (packages/gestures/.cache/public). Everything else is refused. Path-traversal safe: the URL path
 * is decoded once, rejected if it contains `..`, `\`, NUL or an empty/dot segment, only allow-listed
 * top-level folders are served, and the real (symlink-resolved) path must stay inside the root.
 */
import { realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";

export const GESTURE_ASSET_SCHEME = "pointy-gestures-assets";
export const GESTURE_ASSET_HOST = "assets";
export const GESTURE_ASSET_BASE = `${GESTURE_ASSET_SCHEME}://${GESTURE_ASSET_HOST}`;
/** URL the vision page passes as wasmPath / modelPath. */
export const GESTURE_WASM_URL = `${GESTURE_ASSET_BASE}/mediapipe-wasm`;
export const GESTURE_MODEL_URL = `${GESTURE_ASSET_BASE}/models/gesture_recognizer.task`;

const ALLOWED_DIRS = new Set(["mediapipe-wasm", "models"]);

const MIME: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".task": "application/octet-stream",
  ".json": "application/json",
};

export function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

export type AssetPathResult = { ok: true; segments: string[] } | { ok: false; status: 400 | 403 | 404 };

/** Validate the URL and return its decoded path segments (relative to the asset root), without touching disk. */
export function parseAssetUrl(rawUrl: string): AssetPathResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400 };
  }
  if (url.protocol !== `${GESTURE_ASSET_SCHEME}:` || url.hostname !== GESTURE_ASSET_HOST) return { ok: false, status: 404 };
  // Reject encoded traversal before and after decoding (%2e%2e, %2f, %5c, double encoding).
  const rawPath = url.pathname;
  if (/%(2e|2f|5c|00|25)/i.test(rawPath)) return { ok: false, status: 403 };
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, status: 400 };
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return { ok: false, status: 403 };
  const segments = decoded.split("/").slice(1);
  if (segments.length < 2 || segments.some((s) => s === "" || s === "." || s === "..")) return { ok: false, status: 403 };
  if (!ALLOWED_DIRS.has(segments[0] ?? "")) return { ok: false, status: 404 };
  return { ok: true, segments };
}

export interface ResolvedAsset {
  status: 200;
  path: string;
  mime: string;
  size: number;
}
export type AssetResolution = ResolvedAsset | { status: 400 | 403 | 404 | 405 };

/** Resolve a request to a real file under `root`, or an HTTP status. */
export async function resolveAssetRequest(rootDir: string, method: string, rawUrl: string): Promise<AssetResolution> {
  if (method !== "GET" && method !== "HEAD") return { status: 405 };
  const parsed = parseAssetUrl(rawUrl);
  if (!parsed.ok) return { status: parsed.status };
  let realRoot: string;
  try {
    realRoot = await realpath(rootDir);
  } catch {
    return { status: 404 };
  }
  const candidate = join(realRoot, ...parsed.segments);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return { status: 404 };
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { status: 403 };
  try {
    const st = await stat(real);
    if (!st.isFile()) return { status: 404 };
    return { status: 200, path: real, mime: mimeFor(real), size: st.size };
  } catch {
    return { status: 404 };
  }
}
