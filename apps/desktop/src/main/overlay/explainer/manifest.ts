/**
 * The pre-generated explainer image manifest (assets/explainers/manifest.json), written by
 * scripts/pregen-demo-images.ts and read by FalClient and the voice harness. One schema, one reader.
 *
 * Format: { "entries": [{ "prompt": string, "styleId": string, "file": string }] }, `file` relative
 * to the assets directory.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_FILE = "manifest.json";
export const DEFAULT_STYLE_ID = "default";

export interface ManifestEntry {
  prompt: string;
  styleId: string;
  file: string;
}

export const manifestPath = (assetsDir: string): string => path.join(assetsDir, MANIFEST_FILE);

/** Validated entries from parsed manifest JSON (malformed entries are dropped). */
export function parseManifest(json: unknown): ManifestEntry[] {
  const list = (json as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is ManifestEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as ManifestEntry).prompt === "string" &&
      typeof (e as ManifestEntry).styleId === "string" &&
      typeof (e as ManifestEntry).file === "string",
  );
}

/** Read the manifest; a missing or broken file is an empty manifest. */
export async function readManifest(assetsDir: string): Promise<ManifestEntry[]> {
  try {
    return parseManifest(JSON.parse(await readFile(manifestPath(assetsDir), "utf8")));
  } catch {
    return [];
  }
}

/** The prompts that already have pictures (offered to the model so it can reuse them verbatim). */
export async function readManifestPrompts(assetsDir: string): Promise<string[]> {
  return (await readManifest(assetsDir)).map((e) => e.prompt);
}
