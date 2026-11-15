// Downloads the pretrained MediaPipe gesture recognizer so the app works offline.
// Plain Node (18+), so it works the same on Windows, macOS and Linux.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, ".cache", "public", "models", "gesture_recognizer.task");

const res = await fetch(URL);
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
console.log(`Model saved to ${dest}`);
