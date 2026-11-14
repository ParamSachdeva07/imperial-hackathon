/** Entry of the hidden vision window for the standalone launcher. */
import { startVisionRenderer } from "../../src/electron/renderer";
import { createDebugView } from "./debugView";
import { selfTestSource } from "./selftest";

const params = new URLSearchParams(location.search);
const status = document.getElementById("status");
const preview = document.getElementById("preview") ?? undefined;
const side = document.getElementById("side") ?? undefined;
const show = params.get("show") === "1";

void startVisionRenderer({
  wasmPath: "./mediapipe-wasm",
  modelPath: "./models/gesture_recognizer.task",
  // The video is always placed in the page (as before the debug view existed); the debug
  // drawing only runs when the window is shown.
  ...(preview ? { previewParent: preview } : {}),
  ...(show && preview && side ? { onFrame: createDebugView(preview, side) } : {}),
  ...(params.get("selftest") === "1" ? { source: selfTestSource() } : {}),
}).catch((err: unknown) => {
  if (status) status.textContent = `error: ${String(err)}`;
});

window.pointyGestures?.onCommand((cmd) => {
  if (cmd.type === "session" && status) status.textContent = cmd.active ? "session active" : "idle (raise an open palm)";
});
