/**
 * One transparent, click-through, always-on-top overlay window per display (spec §5.1).
 * Rebuilds windows when displays are added, removed or change metrics.
 */
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from "electron";
import { IPC, type PaintedMessage, type RenderItem, type RenderScene } from "@pointy/shared/overlay/render";
import { ImageKeyRegistry } from "@pointy/shared/overlay/sceneImages";
import type { DisplayInfo, Rect } from "@pointy/shared/overlay";
import { toDisplayInfo } from "./coords";
import type { OverlayPlatform } from "./platform";
import type { SceneSink, ScreenSource } from "./ports";

export interface OverlayWindowManagerOptions {
  platform: OverlayPlatform;
  preloadPath: string;
  /** Loads the overlay page into a window (dev server URL or built file). */
  loadPage: (win: BrowserWindow) => Promise<void>;
  /** setContentProtection(true) unless explicitly disabled for dev screenshots. */
  contentProtection: boolean;
}

interface OverlayWindow {
  displayId: string;
  win: BrowserWindow;
  ready: boolean;
  /** Image keys whose bytes this window already has. */
  sentImages: Set<string>;
}

/** Composition latency to wait for after changing window opacity/visibility (spec §5.1 note). */
const COMPOSITION_SETTLE_MS = 60;

/** Electron `screen` as a ScreenSource. */
export class ElectronScreen implements ScreenSource {
  getDisplays(): DisplayInfo[] {
    return screen.getAllDisplays().map((d) => toDisplayInfo(d));
  }
  getPrimaryDisplayId(): string {
    return String(screen.getPrimaryDisplay().id);
  }
  onDisplaysChanged(cb: () => void): () => void {
    const handler = () => cb();
    screen.on("display-added", handler);
    screen.on("display-removed", handler);
    screen.on("display-metrics-changed", handler);
    return () => {
      screen.removeListener("display-added", handler);
      screen.removeListener("display-removed", handler);
      screen.removeListener("display-metrics-changed", handler);
    };
  }
}

export class OverlayWindowManager implements SceneSink {
  private windows = new Map<string, OverlayWindow>();
  private items: RenderItem[] = [];
  private imageKeys = new Set<string>();
  private readonly images = new ImageKeyRegistry();
  private reduceMotion = false;
  private seq = 0;
  private paintedListeners = new Set<(ids: string[]) => void>();
  private hiddenDepth = 0;
  private hiddenSettled: Promise<void> = Promise.resolve();
  private disposeDisplayListener: (() => void) | null = null;

  constructor(
    private readonly opts: OverlayWindowManagerOptions,
    private readonly screenSource: ScreenSource = new ElectronScreen(),
  ) {}

  start(): void {
    ipcMain.on(IPC.ready, this.handleReady);
    ipcMain.on(IPC.painted, this.handlePainted);
    this.disposeDisplayListener = this.screenSource.onDisplaysChanged(() => this.syncWindows());
    this.syncWindows();
  }

  stop(): void {
    ipcMain.removeListener(IPC.ready, this.handleReady);
    ipcMain.removeListener(IPC.painted, this.handlePainted);
    this.disposeDisplayListener?.();
    for (const w of this.windows.values()) if (!w.win.isDestroyed()) w.win.destroy();
    this.windows.clear();
  }

  publish(items: RenderItem[], opts: { reduceMotion: boolean }): void {
    // Image bytes go to each window once, by key — not inside every scene (see sceneImages.ts).
    const { items: keyed, keys } = this.images.externalize(items);
    const dropped = this.images.prune(keys);
    if (dropped.length) {
      for (const w of this.windows.values()) {
        for (const k of dropped) w.sentImages.delete(k);
        if (w.ready && !w.win.isDestroyed()) w.win.webContents.send(IPC.imageDrop, { keys: dropped });
      }
    }
    this.items = keyed;
    this.imageKeys = keys;
    this.reduceMotion = opts.reduceMotion;
    this.seq += 1;
    for (const w of this.windows.values()) this.sendScene(w);
  }

  onPainted(cb: (ids: string[]) => void): () => void {
    this.paintedListeners.add(cb);
    return () => this.paintedListeners.delete(cb);
  }

  /**
   * Native CGWindowIDs of the overlay windows (what a ScreenCaptureKit exclusion filter needs),
   * parsed from getMediaSourceId() ("window:<CGWindowID>:0").
   */
  getWindowIds(): number[] {
    return [...this.windows.values()]
      .filter((w) => !w.win.isDestroyed())
      .map((w) => Number(w.win.getMediaSourceId().split(":")[1]))
      .filter((n) => Number.isFinite(n));
  }

  async withHidden<T>(fn: () => Promise<T>): Promise<T> {
    this.hiddenDepth += 1;
    if (this.hiddenDepth === 1) {
      for (const w of this.windows.values()) if (!w.win.isDestroyed()) w.win.setOpacity(0);
      this.hiddenSettled = delay(COMPOSITION_SETTLE_MS);
    }
    try {
      // Every concurrent caller waits until the hide has reached the screen.
      await this.hiddenSettled;
      return await fn();
    } finally {
      this.hiddenDepth -= 1;
      if (this.hiddenDepth === 0) {
        for (const w of this.windows.values()) if (!w.win.isDestroyed()) w.win.setOpacity(1);
      }
    }
  }

  /** Create/destroy/resize windows to match the current displays. */
  private syncWindows(): void {
    const displays = this.screenSource.getDisplays();
    const ids = new Set(displays.map((d) => d.id));
    for (const [id, w] of this.windows) {
      if (!ids.has(id)) {
        if (!w.win.isDestroyed()) w.win.destroy();
        this.windows.delete(id);
      }
    }
    for (const d of displays) {
      const existing = this.windows.get(d.id);
      if (existing && !existing.win.isDestroyed()) {
        existing.win.setBounds(d.bounds);
        this.sendScene(existing);
      } else {
        this.windows.set(d.id, this.createWindow(d));
      }
    }
  }

  private createWindow(d: DisplayInfo): OverlayWindow {
    const win = new BrowserWindow({
      ...this.opts.platform.overlayWindowOptions(),
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.opts.platform.applyOverlayFlags(win, { contentProtection: this.opts.contentProtection });
    win.setBounds(d.bounds);
    const entry: OverlayWindow = { displayId: d.id, win, ready: false, sentImages: new Set() };
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      if (this.hiddenDepth > 0) win.setOpacity(0);
      this.opts.platform.showWithoutFocus(win);
      win.setBounds(d.bounds);
    });
    // A crashed overlay renderer is reloaded; the scene is resent on its next `overlay:ready`.
    win.webContents.on("render-process-gone", () => {
      entry.ready = false;
      entry.sentImages.clear();
      if (!win.isDestroyed()) void this.opts.loadPage(win);
    });
    void this.opts.loadPage(win);
    return entry;
  }

  private sendScene(w: OverlayWindow): void {
    if (!w.ready || w.win.isDestroyed()) return;
    for (const key of this.imageKeys) {
      if (w.sentImages.has(key)) continue;
      const src = this.images.src(key);
      if (src) w.win.webContents.send(IPC.image, { key, src });
      w.sentImages.add(key);
    }
    const bounds: Rect = w.win.getBounds();
    const display = this.screenSource.getDisplays().find((d) => d.id === w.displayId);
    const scene: RenderScene = {
      seq: this.seq,
      // The window's real origin (macOS may keep a window below the menu bar), so the renderer's
      // global→local translation is always exact.
      display: { id: w.displayId, bounds, scaleFactor: display?.scaleFactor ?? 1 },
      reduceMotion: this.reduceMotion,
      items: this.items,
    };
    w.win.webContents.send(IPC.render, scene);
  }

  private findBySender(e: IpcMainEvent): OverlayWindow | undefined {
    for (const w of this.windows.values()) if (!w.win.isDestroyed() && w.win.webContents.id === e.sender.id) return w;
    return undefined;
  }

  private handleReady = (e: IpcMainEvent) => {
    const w = this.findBySender(e);
    if (!w) return;
    w.ready = true;
    w.sentImages.clear(); // a (re)loaded page has no cached images
    this.sendScene(w);
  };

  private handlePainted = (e: IpcMainEvent, msg: PaintedMessage) => {
    if (!this.findBySender(e) || !Array.isArray(msg?.ids)) return;
    const ids = msg.ids.filter((id): id is string => typeof id === "string");
    for (const cb of this.paintedListeners) cb(ids);
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
