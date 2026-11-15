export * from "./events";
export * from "./config";
export { GestureInterpreter } from "./interpreter";
export { OneEuroFilter, OneEuroFilter2D } from "./oneEuro";
export { classifyPose, ruleBasedPose, PoseTracker, type Pose } from "./pose";
export { bbox } from "./geometry";
export { computeActiveZone } from "./calibration";
// The MediaPipe wrapper is a separate entry so the interpreter stays dependency-free:
//   import { HandDetector } from "@pointy/gestures/detector";
