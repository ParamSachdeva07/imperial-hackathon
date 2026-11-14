import { startFeedbackRenderer } from "@pointy/gestures/electron/feedback-renderer";

// The gestures package draws the user's own hand feedback (cursor, trail, rings, wake ring, selection)
// on a canvas in this click-through window. The AI overlay never draws any of it.
startFeedbackRenderer();
