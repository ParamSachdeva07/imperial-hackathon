/** Entry of the hidden vision window for the standalone launcher. */
import { startVisionRenderer } from "../../src/electron/renderer";
import { selfTestSource } from "./selftest";

const params = new URLSearchParams(location.search);
const status = document.getElementById("status");

void startVisionRenderer({
  wasmPath: "./mediapipe-wasm",
  modelPath: "./models/gesture_recognizer.task",
  previewParent: document.getElementById("preview") ?? undefined,
  ...(params.get("selftest") === "1" ? { source: selfTestSource() } : {}),
}).catch((err: unknown) => {
  if (status) status.textContent = `error: ${String(err)}`;
});

window.pointyGestures?.onCommand((cmd) => {
  if (cmd.type === "session" && status) status.textContent = cmd.active ? "session active" : "idle (raise an open palm)";
});
