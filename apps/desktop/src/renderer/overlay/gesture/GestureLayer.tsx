/**
 * Hand-gesture feedback drawn above the scene: hand cursor, hold ring, fading trail, selection
 * flashes. Fed by `pointyOverlay.onGesture` (a separate stream from scenes), stamped with
 * performance.now() on arrival. An rAF loop runs only while a trail or flash is alive.
 */
import { useEffect, useRef, useState } from "react";
import type { Point, Rect } from "@pointy/shared/overlay/schemas";
import type { RenderTarget } from "@pointy/shared/overlay/render";
import { theme } from "@pointy/shared/overlay/theme";
import { polylinePath } from "../geometry";
import { Ring } from "../primitives/Ring";
import { GlyphBadge } from "../primitives/ToneGlyph";
import { themeStyle } from "../tokens";
import { applyGestureEvents, initialGestureState, isGestureAnimating, pruneGesture, type Flash, type GestureState } from "./gestureFeedback";

const G = theme.gesture;
/** Hand glyph viewBox is 48x48; the fingertip hotspot sits at (HOT_X, HOT_Y). */
const HOT_X = 20;
const HOT_Y = 4;
const TRAIL_CHUNK = 6;

export function GestureLayer({ display, reduceMotion }: { display: Rect | null; reduceMotion: boolean }) {
  const [state, setState] = useState<GestureState>(initialGestureState);
  const [now, setNow] = useState(() => performance.now());
  const ref = useRef<GestureState>(initialGestureState);
  const raf = useRef(0);

  useEffect(() => {
    const commit = (next: GestureState, t: number) => {
      ref.current = next;
      setState(next);
      setNow(t);
    };
    const tick = () => {
      raf.current = 0;
      const t = performance.now();
      commit(pruneGesture(ref.current, t), t);
      if (isGestureAnimating(ref.current)) raf.current = requestAnimationFrame(tick);
    };
    const off = window.pointyOverlay?.onGesture?.((msg) => {
      const t = performance.now();
      commit(applyGestureEvents(ref.current, msg.events, t), t);
      if (isGestureAnimating(ref.current) && raf.current === 0) raf.current = requestAnimationFrame(tick);
    });
    return () => {
      off?.();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, []);

  if (!display) return null;
  return <GestureSurface state={state} now={now} display={display} reduceMotion={reduceMotion} />;
}

/** Root + view (no hooks): shared by the real layer and the gallery. `still` freezes flash fades. */
export function GestureSurface({
  state,
  now,
  display,
  reduceMotion,
  still = false,
}: {
  state: GestureState;
  now: number;
  display: Rect;
  reduceMotion: boolean;
  still?: boolean;
}) {
  return (
    <div
      className={`overlay-root gesture-root${reduceMotion ? " reduce" : ""}${still ? " still" : ""}`}
      data-gesture-session={state.session ? 1 : 0}
      style={{ ...themeStyle, transform: `translate(${-display.x}px, ${-display.y}px)` }}
    >
      <GestureView state={state} now={now} display={display} reduceMotion={reduceMotion} />
    </div>
  );
}

export function GestureView({ state, now, display, reduceMotion }: { state: GestureState; now: number; display: Rect; reduceMotion: boolean }) {
  const { cursor, mouseCursor, drawProgress, mouseProgress, trail, flashes, session } = state;
  const showLive = session;
  return (
    <>
      {showLive && trail.length >= 2 ? <Trail trail={trail} now={now} reduceMotion={reduceMotion} /> : null}
      {flashes.map((f) => (
        <FlashView key={f.id} flash={f} />
      ))}
      {showLive && drawProgress ? (
        <svg className="layer" width="1" height="1" aria-hidden="true">
          <ProgressRing at={drawProgress.at} value={drawProgress.value} kind={drawProgress.progressKind} />
        </svg>
      ) : null}
      {showLive && mouseProgress ? (
        <svg className="layer" width="1" height="1" aria-hidden="true">
          <ProgressRing at={mouseProgress.at} value={mouseProgress.value} kind={mouseProgress.progressKind} />
        </svg>
      ) : null}
      {showLive && mouseCursor ? <HandCursor at={mouseCursor.at} mode="mouse" /> : null}
      {showLive && cursor ? <HandCursor at={cursor.at} mode="draw" /> : null}
      {showLive && state.scrolling ? <ScrollBadge display={display} /> : null}
    </>
  );
}

function Trail({ trail, now, reduceMotion }: { trail: GestureState["trail"]; now: number; reduceMotion: boolean }) {
  const chunks: { key: number; d: string; opacity: number }[] = [];
  for (let i = 0; i < trail.length - 1; i += TRAIL_CHUNK) {
    const pts = trail.slice(i, i + TRAIL_CHUNK + 1);
    if (pts.length < 2) continue;
    const newest = pts[pts.length - 1]!;
    // Reduce motion: no fade animation; the trail simply stays at full strength until it expires.
    const opacity = reduceMotion ? 1 : Math.max(0.08, 1 - (now - newest.t) / G.trailMs);
    chunks.push({ key: i, d: polylinePath(pts), opacity });
  }
  return (
    <svg className="layer gesture-trail" width="1" height="1" aria-hidden="true" data-gesture-trail={trail.length}>
      {chunks.map((c) => (
        <g key={c.key} className="gesture-trail-seg" style={{ opacity: c.opacity }}>
          <path className="gesture-trail-outline" d={c.d} />
          <path className="gesture-trail-line" d={c.d} />
        </g>
      ))}
    </svg>
  );
}

function ProgressRing({ at, value, kind }: { at: Point; value: number; kind: "dwell" | "click" }) {
  const r = G.ringRadius;
  return (
    <g className={`gesture-progress progress-${kind}`} data-gesture-progress={kind} data-value={value}>
      <circle className="gesture-ring-outline" cx={at.x} cy={at.y} r={r} />
      <circle className="gesture-ring-track" cx={at.x} cy={at.y} r={r} />
      <circle
        className="gesture-ring-arc"
        cx={at.x}
        cy={at.y}
        r={r}
        pathLength={1}
        strokeDasharray="1 1"
        strokeDashoffset={1 - value}
        transform={`rotate(-90 ${at.x} ${at.y})`}
      />
    </g>
  );
}

/**
 * Matches DEFAULT_CONFIG of @pointy/gestures: two fingers (peace sign) draw/select, one finger
 * (pointing) drives the mouse. The shape differs, not just the colour.
 * The fingertip hotspot is exactly on `at`.
 */
function HandCursor({ at, mode }: { at: Point; mode: "draw" | "mouse" }) {
  const size = G.cursorSize;
  const k = size / 48;
  return (
    <div
      className={`gesture-cursor mode-${mode}`}
      data-gesture-cursor={mode}
      style={{ left: at.x - HOT_X * k, top: at.y - HOT_Y * k, width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
        {mode === "mouse" ? (
          <>
            <rect className="hand-shape" x="15.5" y="4" width="9" height="26" rx="4.5" />
            <rect className="hand-shape" x="8" y="22" width="28" height="22" rx="9" />
          </>
        ) : (
          <>
            <rect className="hand-shape" x="9.5" y="4" width="9" height="26" rx="4.5" />
            <rect className="hand-shape" x="21.5" y="4" width="9" height="26" rx="4.5" />
            <rect className="hand-shape" x="8" y="22" width="28" height="22" rx="9" />
          </>
        )}
      </svg>
    </div>
  );
}

/** Closed-fist scrolling: a vertical double arrow in a ring, parked at the right edge. */
function ScrollBadge({ display }: { display: Rect }) {
  const s = G.scrollBadgeSize;
  const x = display.x + display.width - s - 24;
  const y = display.y + display.height / 2 - s / 2;
  return (
    <div className="gesture-scroll" data-gesture-scroll style={{ left: x, top: y, width: s, height: s }}>
      <svg width={s} height={s} viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="14" className="scroll-disc" />
        <path d="M16 7l5 6h-10zM16 25l5-6h-10z" className="scroll-arrows" />
      </svg>
    </div>
  );
}

const FLASH_RADIUS = 1;

function flashTarget(f: Flash): { target: RenderTarget; tone: "info" | "success"; badge: Point } {
  if (f.kind === "region") {
    return {
      target: { bounds: f.bounds, shape: { kind: "polygon", points: f.points } },
      tone: "info",
      badge: { x: f.bounds.x + f.bounds.width + 14, y: f.bounds.y - 14 },
    };
  }
  const bounds: Rect = { x: f.at.x - FLASH_RADIUS, y: f.at.y - FLASH_RADIUS, width: 2 * FLASH_RADIUS, height: 2 * FLASH_RADIUS };
  return {
    target: { bounds, shape: { kind: "point", point: f.at } },
    tone: f.kind === "click" ? "success" : "info",
    badge: { x: f.at.x + 52, y: f.at.y - 52 },
  };
}

/** Ring (point: circle, region: the circled polygon) plus a tone glyph so colour is never alone. */
function FlashView({ flash }: { flash: Flash }) {
  const { target, tone, badge } = flashTarget(flash);
  return (
    <div className={`gesture-flash flash-${flash.kind}`} data-gesture-flash={flash.kind}>
      <svg className="layer" width="1" height="1" aria-hidden="true">
        <Ring target={target} tone={tone} pulse={false} />
      </svg>
      <GlyphBadge tone={tone === "success" ? "success" : "info"} x={badge.x} y={badge.y} />
    </div>
  );
}
