import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrokerServer } from "./app.js";
import { DEFAULT_MODEL_ID, fetchDownload, makeFalGenerate } from "./falGenerate.js";
import { ImageService } from "./imageService.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

/** Loads FAL_KEY etc. from the repo-root .env (gitignored); a missing file is fine. */
export function loadEnv(): void {
  const file = path.join(root, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

function main(): void {
  loadEnv();
  const apiKey = process.env["FAL_KEY"];
  if (!apiKey) {
    console.error("FAL_KEY is not set (put it in the repo-root .env). Exiting.");
    process.exit(1);
  }
  const modelId = process.env["FAL_MODEL_ID"] || DEFAULT_MODEL_ID;
  const port = Number(process.env["EXPLAINER_BROKER_PORT"] || 47620);
  const service = new ImageService({
    modelId,
    cacheDir: path.resolve(here, "../.cache"),
    generate: makeFalGenerate(modelId, apiKey),
    download: fetchDownload,
  });
  const server = createBrokerServer(service, () => `http://127.0.0.1:${port}`);
  server.listen(port, "127.0.0.1", () => {
    console.log(`explainer broker listening on http://127.0.0.1:${port} (model ${modelId})`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
