import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayInfo } from "@pointy/shared/overlay";

// ---- minimal Electron fake -------------------------------------------------------------------
const h = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (e: { sender: { id: number } }, msg?: unknown) => void>();
  let nextId = 1;
  class FakeWebContents {
    id = nextId++;
    sent: { channel: string; payload: unknown }[] = [];
    send(channel: string, payload: unknown) {
      this.sent.push({ channel, payload });
    }
    on() {}
  }
  class FakeBrowserWindow {
    static all: FakeBrowserWindow[] = [];
    webContents = new FakeWebContents();
    opacity = 1;
    destroyed = false;
    bounds: { x: number; y: number; width: number; height: number };
    constructor(opts: { x: number; y: number; width: number; height: number }) {
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      FakeBrowserWindow.all.push(this);
    }
    once() {}
    setBounds(b: typeof this.bounds) {
      this.bounds = b;
    }
    getBounds() {
      return this.bounds;
    }
    setOpacity(o: number) {
      this.opacity = o;
    }
    getOpacity() {
      return this.opacity;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    getMediaSourceId() {
      return `window:${1000 + this.webContents.id}:0`;
    }
  }
  return { ipcHandlers, FakeBrowserWindow };
});

vi.mock("electron", () => ({
  BrowserWindow: h.FakeBrowserWindow,
  ipcMain: {
    on: (ch: string, fn: (e: { sender: { id: number } }, msg?: unknown) => void) => h.ipcHandlers.set(ch, fn),
    removeListener: (ch: string) => h.ipcHandlers.delete(ch),
  },
  screen: {},
}));

const { OverlayWindowManager } = await import("./OverlayWindowManager");

const D1: DisplayInfo = { id: "1", bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 }, scaleFactor: 2 };
const D2: DisplayInfo = { id: "2", bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

function setup(displays: DisplayInfo[]) {
  let changed: () => void = () => {};
  const screenSource = {
    displays,
    getDisplays: () => screenSource.displays,
    getPrimaryDisplayId: () => "1",
    onDisplaysChanged: (cb: () => void) => {
      changed = cb;
      return () => {};
    },
  };
  const platform = {
    overlayWindowOptions: () => ({}),
    applyOverlayFlags: vi.fn(),
    showWithoutFocus: vi.fn(),
    prefersReducedMotion: () => false,
  };
  const wm = new OverlayWindowManager({ platform, preloadPath: "p", loadPage: async () => {}, contentProtection: true }, screenSource);
  wm.start();
  const ready = (w: InstanceType<typeof h.FakeBrowserWindow>) => h.ipcHandlers.get("overlay:ready")!({ sender: { id: w.webContents.id } });
  return { wm, screenSource, platform, ready, change: () => changed() };
}

describe("OverlayWindowManager", () => {
  beforeEach(() => {
    h.FakeBrowserWindow.all = [];
    h.ipcHandlers.clear();
  });

  it("creates one protected, flagged window per display and rebuilds on display changes", () => {
    const { wm, screenSource, platform, change } = setup([D1, D2]);
    expect(h.FakeBrowserWindow.all).toHaveLength(2);
    expect(platform.applyOverlayFlags).toHaveBeenCalledWith(expect.anything(), { contentProtection: true });
    expect(wm.getWindowIds()).toHaveLength(2);
    screenSource.displays = [D1];
    change();
    expect(h.FakeBrowserWindow.all.filter((w) => !w.destroyed)).toHaveLength(1);
  });

  it("sends scenes with the window's real origin, and image bytes once per window", () => {
    const { wm, ready } = setup([D1]);
    const win = h.FakeBrowserWindow.all[0]!;
    ready(win);
    const src = "data:image/png;base64,AAAA";
    const item = {
      kind: "explainer" as const,
      id: "ex_1",
      state: "visible" as const,
      title: "t",
      anchor: null,
      designSize: { width: 520, height: 300 },
      imageScale: 1,
      scale: 1,
      card: { x: 0, y: 0, width: 520, height: 300 },
      connector: null,
      body: { kind: "anatomy" as const, image: { status: "ready" as const, src }, aspect: 2, callouts: [] },
    };
    wm.publish([item], { reduceMotion: false });
    wm.publish([item], { reduceMotion: false });
    const images = win.webContents.sent.filter((m) => m.channel === "overlay:image");
    const scenes = win.webContents.sent.filter((m) => m.channel === "overlay:render");
    expect(images).toHaveLength(1);
    expect(JSON.stringify(scenes.at(-1)!.payload)).not.toContain(src);
    expect((scenes.at(-1)!.payload as { display: { bounds: unknown } }).display.bounds).toEqual(D1.bounds);
    wm.publish([], { reduceMotion: false });
    expect(win.webContents.sent.some((m) => m.channel === "overlay:image-drop")).toBe(true);
  });

  it("withHidden hides every window until the outermost call finishes", async () => {
    const { wm } = setup([D1, D2]);
    let inner = -1;
    await wm.withHidden(async () => {
      await wm.withHidden(async () => {
        inner = h.FakeBrowserWindow.all[0]!.opacity;
      });
      expect(h.FakeBrowserWindow.all.every((w) => w.opacity === 0)).toBe(true);
    });
    expect(inner).toBe(0);
    // Fades back in (never an abrupt blink).
    await new Promise((r) => setTimeout(r, 250));
    expect(h.FakeBrowserWindow.all.every((w) => w.opacity === 1)).toBe(true);
  });

  it("ignores painted acks from non-overlay senders", () => {
    const { wm } = setup([D1]);
    const cb = vi.fn();
    wm.onPainted(cb);
    h.ipcHandlers.get("overlay:painted")!({ sender: { id: 9999 } }, { seq: 1, ids: ["x"] });
    expect(cb).not.toHaveBeenCalled();
    h.ipcHandlers.get("overlay:painted")!({ sender: { id: h.FakeBrowserWindow.all[0]!.webContents.id } }, { seq: 1, ids: ["x"] });
    expect(cb).toHaveBeenCalledWith(["x"]);
  });

  it("sends gesture frames to ready windows only, without a scene or a seq bump", () => {
    const { wm, ready } = setup([D1, D2]);
    const [a, b] = h.FakeBrowserWindow.all as [InstanceType<typeof h.FakeBrowserWindow>, InstanceType<typeof h.FakeBrowserWindow>];
    ready(a);
    const rendersBefore = a.webContents.sent.filter((m) => m.channel === "overlay:render");
    const seqBefore = (rendersBefore.at(-1)!.payload as { seq: number }).seq;
    const msg = { events: [{ kind: "lost" as const }] };
    wm.sendGesture(msg);
    expect(a.webContents.sent.filter((m) => m.channel === "overlay:gesture")).toEqual([{ channel: "overlay:gesture", payload: msg }]);
    expect(b.webContents.sent).toHaveLength(0); // not ready
    const rendersAfter = a.webContents.sent.filter((m) => m.channel === "overlay:render");
    expect(rendersAfter).toHaveLength(rendersBefore.length);
    wm.publish([], { reduceMotion: false });
    const last = a.webContents.sent.filter((m) => m.channel === "overlay:render").at(-1)!.payload as { seq: number };
    expect(last.seq).toBe(seqBefore + 1); // only publish() bumps it
    a.destroy();
    expect(() => wm.sendGesture(msg)).not.toThrow();
  });

  it("replays an open gesture session to a renderer that becomes ready (or reloads) later", () => {
    const { wm, ready } = setup([D1]);
    const [a] = h.FakeBrowserWindow.all as [InstanceType<typeof h.FakeBrowserWindow>];
    wm.sendGesture({ events: [{ kind: "session", active: true }] }); // before the renderer is ready
    ready(a);
    const sessionMsgs = () => a.webContents.sent.filter((m) => m.channel === "overlay:gesture");
    expect(sessionMsgs()).toEqual([{ channel: "overlay:gesture", payload: { events: [{ kind: "session", active: true }] } }]);
    ready(a); // reload
    expect(sessionMsgs()).toHaveLength(2);
    wm.sendGesture({ events: [{ kind: "session", active: false }] });
    ready(a);
    expect(sessionMsgs()).toHaveLength(3); // the close itself; nothing replayed afterwards
  });
});
