import { describe, expect, it, vi } from "vitest";
import { ASSISTANT_HOTKEY, buildMenuModel, isAssistantActive, tooltipFor, type TrayActions } from "./trayModel";
import { drawTrayIcon, toBgra } from "./trayIcon";
import { SETTINGS_LINKS, degradation, missing, normalizeMediaStatus, summarize, type PermissionReport } from "./permissionsModel";

const actions = (): TrayActions => ({
  openAssistant: vi.fn(),
  closeAssistant: vi.fn(),
  setMouseEnabled: vi.fn(),
  setGesturesEnabled: vi.fn(),
  checkPermissions: vi.fn(),
  quit: vi.fn(),
});

describe("tray model", () => {
  it("offers Open when idle and Close when active", () => {
    const a = actions();
    const idle = buildMenuModel({ status: "idle", mouseEnabled: true, gesturesEnabled: true }, a);
    expect(idle.some((m) => m.kind === "action" && m.label === "Open assistant" && m.accelerator === ASSISTANT_HOTKEY)).toBe(true);
    const act = buildMenuModel({ status: "listening", mouseEnabled: true, gesturesEnabled: true }, a);
    expect(act.some((m) => m.kind === "action" && m.label === "Close assistant")).toBe(true);
    expect(isAssistantActive("error")).toBe(false);
  });
  it("reflects toggles and wires actions", () => {
    const a = actions();
    const items = buildMenuModel({ status: "idle", mouseEnabled: false, gesturesEnabled: true, permissionsSummary: "Permissions: x" }, a);
    const mouse = items.find((m) => m.kind === "checkbox" && m.label.startsWith("Mouse"));
    expect(mouse).toMatchObject({ checked: false });
    if (mouse?.kind === "checkbox") mouse.run(true);
    expect(a.setMouseEnabled).toHaveBeenCalledWith(true);
    expect(items.some((m) => m.kind === "label" && m.label === "Permissions: x")).toBe(true);
    const quit = items.find((m) => m.kind === "action" && m.label.startsWith("Quit"));
    if (quit?.kind === "action") quit.run();
    expect(a.quit).toHaveBeenCalled();
  });
  it("tooltip", () => expect(tooltipFor("speaking")).toBe("Pointy: Speaking"));
});

describe("tray icon", () => {
  it("draws non-empty icons of the right size, differing per status", () => {
    const idle = drawTrayIcon("idle", 1);
    const listening = drawTrayIcon("listening", 1);
    const retina = drawTrayIcon("idle", 2);
    expect(idle.width).toBe(18);
    expect(retina.width).toBe(36);
    expect(idle.data.length).toBe(18 * 18 * 4);
    expect(idle.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
    expect(Buffer.from(idle.data).equals(Buffer.from(listening.data))).toBe(false);
    expect(toBgra(idle).length).toBe(idle.data.length);
  });
});

describe("permissions model", () => {
  const all: PermissionReport = { camera: "granted", microphone: "granted", accessibility: "granted", screen: "granted" };
  it("summarizes in one line", () => {
    expect(summarize(all)).toBe("Permissions: Camera ok, Microphone ok, Accessibility ok, Screen Recording ok");
    expect(summarize({ ...all, accessibility: "denied" })).toContain("Accessibility MISSING");
    expect(summarize(all)).not.toContain("\n");
  });
  it("finds missing and degradations", () => {
    const r: PermissionReport = { ...all, accessibility: "denied", camera: "not-determined" };
    expect(missing(r)).toEqual(["camera", "accessibility"]);
    expect(degradation(r).join(" ")).toMatch(/screenshot-only/);
    expect(degradation(r).join(" ")).toMatch(/hotkey/);
    expect(degradation(all)).toEqual([]);
  });
  it("normalizes and links", () => {
    expect(normalizeMediaStatus("weird")).toBe("unknown");
    expect(normalizeMediaStatus("granted")).toBe("granted");
    expect(SETTINGS_LINKS.screen).toContain("Privacy_ScreenCapture");
  });
});
