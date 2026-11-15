import { app, globalShortcut, shell, systemPreferences } from "electron";
import { ASSISTANT_HOTKEY } from "./trayModel";
import {
  SETTINGS_LINKS,
  degradation,
  missing,
  normalizeMediaStatus,
  summarize,
  type PermKey,
  type PermissionReport,
} from "./permissionsModel";

export { SETTINGS_LINKS, summarize, degradation, missing, type PermKey, type PermissionReport } from "./permissionsModel";

export interface PermissionCheck extends PermissionReport {
  summary: string;
  missing: PermKey[];
  degraded: string[];
}

/** Reads current grants without prompting. Grants apply to the launching app (e.g. the terminal) in dev. */
export function checkPermissions(): PermissionCheck {
  const media = (t: "camera" | "microphone" | "screen") => normalizeMediaStatus(systemPreferences.getMediaAccessStatus(t));
  const report: PermissionReport = {
    camera: media("camera"),
    microphone: media("microphone"),
    accessibility: process.platform === "darwin" && systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
    screen: media("screen"),
  };
  return { ...report, summary: summarize(report), missing: missing(report), degraded: degradation(report) };
}

/** Opens the System Settings pane for one permission. */
export function openSettings(key: PermKey): Promise<void> {
  return shell.openExternal(SETTINGS_LINKS[key]);
}

/** Opens panes for everything missing (Accessibility also triggers the system prompt). */
export async function openMissingSettings(check: PermissionCheck = checkPermissions()): Promise<void> {
  for (const k of check.missing) {
    if (k === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
    else if ((k === "camera" || k === "microphone") && check[k] === "not-determined") await systemPreferences.askForMediaAccess(k);
    await openSettings(k);
  }
}

/** Global shortcut Cmd+Option+P. Returns false when the shortcut is taken. */
export function registerAssistantHotkey(cb: () => void): { ok: boolean; unregister(): void } {
  const ok = globalShortcut.register(ASSISTANT_HOTKEY, cb);
  return { ok, unregister: () => globalShortcut.unregister(ASSISTANT_HOTKEY) };
}

/** Production mode is a menu-bar app: no Dock icon. */
export function hideDockInProduction(isProduction: boolean): void {
  if (isProduction && process.platform === "darwin") app.dock?.hide();
}
