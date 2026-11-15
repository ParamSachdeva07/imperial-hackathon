/**
 * Accessibility-backed element provider: snapshots the frontmost non-Pointy app through the resident
 * helper, resolves element bounds for the overlay, and tells it when anchored elements move. No electron
 * imports (the display lookup is injected).
 *
 * Anchors: every id the overlay asks about via getBounds() becomes an anchor. While anchors exist, a batched
 * `resolve` runs every `resolveIntervalMs` and onChange fires when an anchor moves >= 1pt or disappears.
 * Call clearAnchors() when the overlay is cleared (end of session / turn) so polling stops.
 */
import type { ElementBounds, Rect } from "@pointy/shared/overlay";
import type { HelperEvent, RawElement, RawRect, RawSnapshot } from "./AxHelperClient";
import type { AxProvider, ElementInfo, ElementSnapshot } from "./types";

/** What the provider needs from AxHelperClient (a fake implements it in tests). */
export interface AxHelperLike {
  start(): void;
  stop(): void;
  readonly available: boolean;
  onEvent(cb: (e: HelperEvent) => void): () => void;
  snapshot(maxElements: number, excludePids: number[]): Promise<RawSnapshot>;
  resolve(ids: string[]): Promise<Record<string, RawRect | null>>;
  trusted(): Promise<boolean>;
  /** Optional: element under a global point. */
  elementAt?(x: number, y: number, excludePids: number[]): Promise<RawElement | null>;
  /** Optional: gate the helper's reading/observing (it starts inactive). */
  setActive?(on: boolean): Promise<void>;
}

export interface AxBoundsProviderOptions {
  client: AxHelperLike;
  /** Electron: `(r) => screen.getDisplayMatching(r)`. */
  getDisplayMatching: (rect: Rect) => { id: number | string };
  /** Pids the helper must never snapshot (Pointy itself, the Anam avatar). Evaluated per snapshot. */
  excludePids?: () => number[];
  /** Initial active state. Default true; production starts false and follows the assistant session. */
  active?: boolean;
  /** Default 150 (the assistant prompt size); the helper caps at 4000. */
  maxElements?: number;
  /** Observer-event debounce. Default 150. */
  debounceMs?: number;
  /** Anchor poll period. Default 300. */
  resolveIntervalMs?: number;
  /** Anchors are forgotten this long after the last getBounds() for them. Default 5 min. */
  anchorTtlMs?: number;
  /** How often to re-check a missing Accessibility grant. Default 3000. */
  trustPollMs?: number;
  /** Previous turn-snapshots kept for id lookups. Default 2. */
  keepPrevious?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

const MOVE_EPSILON = 1;

interface Anchor {
  rect: Rect | null;
  lastAsked: number;
}

function toInfo(e: RawElement, getDisplay: AxBoundsProviderOptions["getDisplayMatching"]): ElementInfo {
  const rect: Rect = { x: e.x, y: e.y, width: Math.max(1, e.w), height: Math.max(1, e.h) };
  const info: ElementInfo = {
    id: e.id,
    role: e.role,
    label: e.label,
    window: e.window,
    rect,
    displayId: String(getDisplay(rect).id),
  };
  if (e.focused) info.focused = true;
  return info;
}

function rectFromRaw(r: RawRect): Rect {
  return { x: r.x, y: r.y, width: Math.max(1, r.w), height: Math.max(1, r.h) };
}

function moved(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) >= MOVE_EPSILON ||
    Math.abs(a.y - b.y) >= MOVE_EPSILON ||
    Math.abs(a.width - b.width) >= MOVE_EPSILON ||
    Math.abs(a.height - b.height) >= MOVE_EPSILON
  );
}

export class AxBoundsProvider implements AxProvider {
  private readonly o: AxBoundsProviderOptions;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private current: ElementSnapshot = { app: "", window: "", elements: [], truncated: false, rev: 0 };
  /** Older turn generations, newest first. */
  private previous: ElementSnapshot[] = [];
  /** Elements dropped by observer-driven refreshes since the last turn: the model may still hold their ids. */
  private shadow = new Map<string, ElementInfo>();
  private rev = 0;
  private _trusted = false;
  private _active = true;
  private started = false;
  private readonly changeListeners = new Set<() => void>();
  private readonly contextListeners = new Set<(reason: string) => void>();
  private readonly trustListeners = new Set<(t: boolean) => void>();
  private readonly anchors = new Map<string, Anchor>();
  private unsubEvents: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private trustTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private inflight: Promise<ElementSnapshot> | null = null;

  constructor(options: AxBoundsProviderOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this._active = options.active ?? true;
  }

  get trusted(): boolean {
    return this._trusted;
  }

  onTrustedChange(cb: (trusted: boolean) => void): () => void {
    this.trustListeners.add(cb);
    return () => this.trustListeners.delete(cb);
  }

  /**
   * The desktop context changed under the user (app/window focus, move, resize, new or minimised window), as
   * opposed to an element anchor moving. Screenshot-derived annotations are stale after this. Title changes
   * are ignored (tab titles churn).
   */
  onContextEvent(cb: (reason: string) => void): () => void {
    this.contextListeners.add(cb);
    return () => this.contextListeners.delete(cb);
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** Starts the helper and subscribes to its change events. Never throws. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubEvents = this.o.client.onEvent((e) => this.onHelperEvent(e));
    this.o.client.start();
    void this.o.client.setActive?.(this._active);
    try {
      this.setTrusted(await this.o.client.trusted());
    } catch {
      this.setTrusted(false);
    }
    this.ensureTrustPoll();
  }

  /**
   * Screen/AX data is read only while the assistant is open. Inactive: helper events are ignored, no snapshot
   * is taken (snapshotNow returns an empty one), the helper detaches its observer, and every cached element is
   * dropped. Active again: callers snapshot as usual.
   */
  setActive(on: boolean): void {
    if (on === this._active) return;
    this._active = on;
    void this.o.client.setActive?.(on);
    if (on) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.anchors.clear();
    this.stopPoll();
    this.current = { app: "", window: "", elements: [], truncated: false, rev: this.rev };
    this.previous = [];
    this.shadow.clear();
  }

  get active(): boolean {
    return this._active;
  }

  stop(): void {
    this.started = false;
    this.unsubEvents?.();
    this.unsubEvents = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.stopPoll();
    if (this.trustTimer) clearInterval(this.trustTimer);
    this.trustTimer = null;
    this.o.client.stop();
  }

  listElements(): ElementInfo[] {
    return this.current.elements;
  }

  /** Re-reads the frontmost app's elements. Concurrent calls share one helper request. */
  snapshotNow(reason: string): Promise<ElementSnapshot> {
    if (!this._active) return Promise.resolve({ app: "", window: "", elements: [], truncated: false, rev: this.rev });
    if (this.inflight) return this.inflight;
    const p = this.doSnapshot(reason).finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  async getBounds(elementId: string): Promise<ElementBounds | null> {
    const inCurrent = this.current.elements.find((e) => e.id === elementId);
    const older = inCurrent ? undefined : this.findPrevious(elementId);
    const known = inCurrent ?? older;
    if (!known) return null;
    this.touchAnchor(elementId, known.rect);
    let rect: Rect | null = known.rect;
    try {
      const res = await this.o.client.resolve([elementId]);
      const r = res[elementId];
      if (r) rect = rectFromRaw(r);
      else rect = null; // the helper answered: the element is gone (or off screen). Only a failed request falls back to the cached rect.
    } catch {
      /* helper unavailable: fall back to the snapshot rect */
    }
    if (!rect) return null;
    const anchor = this.anchors.get(elementId);
    if (anchor) anchor.rect = rect;
    return { rect, displayId: String(this.o.getDisplayMatching(rect).id) };
  }

  /**
   * The accessibility element under a global point (e.g. where the mouse pointer / pointing finger is).
   * Never throws: null when inactive, untrusted, unavailable, timed out, or nothing useful is there.
   */
  async elementAt(point: { x: number; y: number }): Promise<ElementInfo | null> {
    if (!this._active || !this.o.client.elementAt || !this.o.client.available) return null;
    try {
      const raw = await this.o.client.elementAt(point.x, point.y, this.o.excludePids?.() ?? [process.pid]);
      if (!raw) return null;
      if (!this._active) return null;
      const info = toInfo(raw, this.o.getDisplayMatching);
      // The id is about to be given to the model: make it resolvable even when the (capped) snapshot omitted this element.
      if (!this.current.elements.some((e) => e.id === info.id)) {
        this.shadow.set(info.id, info);
        while (this.shadow.size > 2000) this.shadow.delete(this.shadow.keys().next().value as string);
      }
      return info;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "not_trusted") this.setTrusted(false);
      return null;
    }
  }

  /** Forget anchors (all, or just these ids); polling stops when none remain. */
  clearAnchors(ids?: string[]): void {
    if (!ids) this.anchors.clear();
    else for (const id of ids) this.anchors.delete(id);
    if (this.anchors.size === 0) this.stopPoll();
  }

  // ---- internals ----

  private findPrevious(id: string): ElementInfo | undefined {
    const sh = this.shadow.get(id);
    if (sh) return sh;
    for (const s of this.previous) {
      const e = s.elements.find((x) => x.id === id);
      if (e) return e;
    }
    return undefined;
  }

  private touchAnchor(id: string, rect: Rect): void {
    const existing = this.anchors.get(id);
    if (existing) existing.lastAsked = this.now();
    else this.anchors.set(id, { rect, lastAsked: this.now() });
    this.ensurePoll();
  }

  private async doSnapshot(reason: string): Promise<ElementSnapshot> {
    let raw: RawSnapshot | null = null;
    try {
      raw = await this.o.client.snapshot(this.o.maxElements ?? 150, this.o.excludePids?.() ?? [process.pid]);
      this.setTrusted(true);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "not_trusted") this.setTrusted(false);
      else if (code !== "no_target") this.log(`[ax] snapshot failed (${code ?? String(err)})`);
    }
    const elements = raw ? raw.elements.map((e) => toInfo(e, this.o.getDisplayMatching)) : [];
    const snap: ElementSnapshot = {
      app: raw?.app ?? "",
      pid: raw?.pid,
      window: raw?.window ?? "",
      elements,
      truncated: raw?.truncated ?? false,
      rev: ++this.rev,
    };
    if (!this._active) return { ...snap, elements: [] }; // closed while the helper was answering: keep nothing
    // A new "generation" starts on each turn; observer-driven refreshes replace the current one in place.
    if (reason.startsWith("turn") && this.current.rev > 0) {
      const have = new Set(this.current.elements.map((e) => e.id));
      const extra = [...this.shadow.values()].filter((e) => !have.has(e.id));
      this.previous.unshift(extra.length ? { ...this.current, elements: [...this.current.elements, ...extra] } : this.current);
      this.previous.length = Math.min(this.previous.length, this.o.keepPrevious ?? 2);
      this.shadow.clear();
    } else if (this.current.rev > 0) {
      // Observer refresh (e.g. a title change): remember what it replaced so ids the model was given still resolve.
      const now = new Set(elements.map((e) => e.id));
      for (const e of this.current.elements) if (!now.has(e.id)) this.shadow.set(e.id, e);
      while (this.shadow.size > 2000) this.shadow.delete(this.shadow.keys().next().value as string);
    }
    this.current = snap;
    return snap;
  }

  private onHelperEvent(e: HelperEvent): void {
    if (e.event === "ready") {
      void this.o.client.setActive?.(this._active); // a restarted helper starts inactive
      if (e.trusted !== undefined) this.setTrusted(e.trusted === true);
      return;
    }
    if (e.event !== "changed" || !this._active) return;
    const reason = e.reason ?? "changed";
    // Context changes (app switch, window move) matter even without AX trust: screenshot-derived drawings must go.
    if (reason !== "AXTitleChanged") for (const cb of [...this.contextListeners]) cb(reason);
    if (!this._trusted) return; // AX snapshots need trust
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.snapshotNow(`event:${e.reason ?? "changed"}`).then(() => this.fire());
    }, this.o.debounceMs ?? 150);
  }

  private fire(): void {
    for (const cb of [...this.changeListeners]) cb();
  }

  private setTrusted(t: boolean): void {
    if (t === this._trusted) return;
    this._trusted = t;
    for (const cb of [...this.trustListeners]) cb(t);
    this.ensureTrustPoll();
  }

  private ensureTrustPoll(): void {
    const need = this.started && !this._trusted;
    if (need && !this.trustTimer) {
      this.trustTimer = setInterval(() => {
        this.o.client.trusted().then(
          (t) => this.setTrusted(t),
          () => {},
        );
      }, this.o.trustPollMs ?? 3000);
      this.trustTimer.unref?.();
    } else if (!need && this.trustTimer) {
      clearInterval(this.trustTimer);
      this.trustTimer = null;
    }
  }

  private ensurePoll(): void {
    if (this.pollTimer || !this.started) return;
    this.pollTimer = setInterval(() => void this.pollAnchors(), this.o.resolveIntervalMs ?? 300);
    this.pollTimer.unref?.();
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollAnchors(): Promise<void> {
    if (this.polling) return;
    const ttl = this.o.anchorTtlMs ?? 5 * 60_000;
    const t = this.now();
    for (const [id, a] of this.anchors) if (t - a.lastAsked > ttl) this.anchors.delete(id);
    if (this.anchors.size === 0) {
      this.stopPoll();
      return;
    }
    this.polling = true;
    try {
      const ids = [...this.anchors.keys()];
      const res = await this.o.client.resolve(ids);
      let changed = false;
      for (const id of ids) {
        const a = this.anchors.get(id);
        if (!a) continue;
        const r = res[id];
        if (!r) {
          if (a.rect !== null) {
            a.rect = null;
            changed = true;
          }
          continue;
        }
        const next = rectFromRaw(r);
        if (a.rect === null || moved(a.rect, next)) {
          a.rect = next;
          changed = true;
        }
      }
      if (changed) this.fire();
    } catch {
      /* helper restarting; try again next tick */
    } finally {
      this.polling = false;
    }
  }
}
