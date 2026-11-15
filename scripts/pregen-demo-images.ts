/**
 * Pre-generates the explainer demo images into assets/explainers/ so the live demo never depends
 * on fal.ai responding. Reads assets/explainers/prompts.json, generates each image with the broker
 * logic (same style suffix, model and cache key), and writes assets/explainers/manifest.json
 * mapping { prompt, styleId } -> file. Idempotent: existing entries with an existing file are
 * skipped. Needs FAL_KEY (repo-root .env). Run with `npm run pregen`.
 */
import { existsSync } from "node:fs";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoEnv } from "@pointy/shared/node/env";
import { manifestPath as manifestFileOf, readManifest, type ManifestEntry } from "../apps/desktop/src/main/overlay/explainer/manifest";
import { DEFAULT_MODEL_ID, fetchDownload, makeFalGenerate } from "../backend/explainer-broker/src/falGenerate.js";
import { DEFAULT_STYLE_ID, ImageService } from "../backend/explainer-broker/src/imageService.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(root, "assets", "explainers");
const MAX_BYTES = 300 * 1024;

interface PromptSpec {
  prompt: string;
  styleId?: string;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  loadRepoEnv(root);
  const apiKey = process.env["FAL_KEY"];
  if (!apiKey) {
    console.error("FAL_KEY is not set (repo-root .env); cannot generate images.");
    process.exit(1);
  }
  const modelId = process.env["FAL_MODEL_ID"] || DEFAULT_MODEL_ID;
  const prompts = await readJson<PromptSpec[]>(path.join(assetsDir, "prompts.json"), []);
  const manifestPath = manifestFileOf(assetsDir);
  const manifest: { entries: ManifestEntry[] } = { entries: await readManifest(assetsDir) };
  const service = new ImageService({
    modelId,
    cacheDir: path.join(root, "backend", "explainer-broker", ".cache"),
    generate: makeFalGenerate(modelId, apiKey),
    download: fetchDownload,
  });

  for (const spec of prompts) {
    const prompt = spec.prompt.trim();
    const styleId = spec.styleId ?? DEFAULT_STYLE_ID;
    const existing = manifest.entries.find((e) => e.prompt === prompt && e.styleId === styleId);
    if (existing && existsSync(path.join(assetsDir, existing.file))) {
      console.log(`skip   ${existing.file}`);
      continue;
    }
    const started = Date.now();
    const cached = await service.getImageFile(prompt, styleId); // `<sha256>.<ext>`
    const file = `${cached.slice(0, 12)}${path.extname(cached)}`;
    await copyFile(path.join(root, "backend", "explainer-broker", ".cache", cached), path.join(assetsDir, file));
    const { size } = await stat(path.join(assetsDir, file));
    if (size > MAX_BYTES) console.warn(`warn   ${file} is ${Math.round(size / 1024)} KB (> 300 KB); recompress it`);
    manifest.entries = manifest.entries.filter((e) => !(e.prompt === prompt && e.styleId === styleId));
    manifest.entries.push({ prompt, styleId, file });
    console.log(`made   ${file} (${Math.round(size / 1024)} KB, ${Date.now() - started} ms)`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : "pregen failed");
  process.exit(1);
});
