// Copies MediaPipe's wasm runtime into .cache/public/ (Vite's publicDir) so nothing loads from a CDN at runtime.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// package.json is not in the package's "exports", so resolve the main bundle instead.
const pkgDir = dirname(require.resolve("@mediapipe/tasks-vision"));
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, ".cache", "public", "mediapipe-wasm");
mkdirSync(dest, { recursive: true });
cpSync(join(pkgDir, "wasm"), dest, { recursive: true });
console.log(`MediaPipe wasm copied to ${dest}`);
