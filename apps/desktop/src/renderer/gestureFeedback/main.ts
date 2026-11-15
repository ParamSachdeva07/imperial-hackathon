import { startFeedbackRenderer } from "@pointy/gestures/electron/feedback-renderer";

// The gestures package draws the user's own hand feedback (cursor, trail, rings, wake ring, selection)
// on a canvas in this click-through window. The AI overlay never draws any of it.
// ?selectionTtlMs=N keeps the selection outline that long (production: the assistant clears it earlier).
const ttl = Number(new URLSearchParams(window.location.search).get("selectionTtlMs"));
startFeedbackRenderer(Number.isFinite(ttl) && ttl > 0 ? { selectionTtlMs: ttl } : undefined);
