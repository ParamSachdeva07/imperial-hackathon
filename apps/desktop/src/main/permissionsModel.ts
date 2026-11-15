/** Pure permission formatting. No electron imports. */
export type PermState = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
export type PermKey = "camera" | "microphone" | "accessibility" | "screen";
export type PermissionReport = Record<PermKey, PermState>;

export const SETTINGS_LINKS: Record<PermKey, string> = {
  camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

const NAMES: Record<PermKey, string> = { camera: "Camera", microphone: "Microphone", accessibility: "Accessibility", screen: "Screen Recording" };
const ORDER: PermKey[] = ["camera", "microphone", "accessibility", "screen"];

export function normalizeMediaStatus(s: string): PermState {
  return s === "granted" || s === "denied" || s === "not-determined" || s === "restricted" ? s : "unknown";
}

export function missing(report: PermissionReport): PermKey[] {
  return ORDER.filter((k) => report[k] !== "granted");
}

/** One line, e.g. "Permissions: Camera ok, Microphone ok, Accessibility MISSING, Screen Recording ok". */
export function summarize(report: PermissionReport): string {
  return "Permissions: " + ORDER.map((k) => `${NAMES[k]} ${report[k] === "granted" ? "ok" : "MISSING"}`).join(", ");
}

/** What still works with the current grants (graceful degradation). */
export function degradation(report: PermissionReport): string[] {
  const out: string[] = [];
  if (report.accessibility !== "granted" && report.screen === "granted") out.push("no Accessibility: screenshot-only context, no element labels");
  if (report.screen !== "granted" && report.accessibility === "granted") out.push("no Screen Recording: element labels only, no screenshots");
  if (report.accessibility !== "granted" && report.screen !== "granted") out.push("no Accessibility or Screen Recording: assistant has no view of the screen");
  if (report.camera !== "granted") out.push("no Camera: hotkey (Cmd+Option+P) only, no gestures");
  if (report.microphone !== "granted") out.push("no Microphone: voice input unavailable");
  return out;
}

export function nameOf(k: PermKey): string {
  return NAMES[k];
}
