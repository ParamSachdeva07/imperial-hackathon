import { startVisionRenderer } from "@pointy/gestures/electron/renderer";

// The custom scheme is served by main (src/main/gestures/startGestures.ts) from
// packages/gestures/.cache/public, so it works from the dev server and from file:// alike.
// Keep in sync with GESTURE_WASM_URL / GESTURE_MODEL_URL in src/main/gestures/assetResolver.ts.
const BASE = "pointy-gestures-assets://assets";

void startVisionRenderer({
  wasmPath: `${BASE}/mediapipe-wasm`,
  modelPath: `${BASE}/models/gesture_recognizer.task`,
  previewParent: document.body,
});
