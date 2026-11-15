/**
 * ExplainerService (spec §7): builds explainer card bodies and loads their async parts.
 *  - sequence / compare text: rendered instantly (local templates).
 *  - concept panels and compare images: image slots start "loading" (calm shimmer) and become
 *    "ready" or "failed" (large nearest-icon fallback) via the ImageSource (FalClient).
 *  - anatomy: crop of the user's own screen (ScreenCaptureProvider) + callouts mapped into the
 *    crop. No fal.ai involved.
 */
import type {
  AnatomyCallout,
  AnatomySpec,
  DisplayInfo,
  ExplainerBody,
  ExplainerSpec,
  ImageSlot,
  ScreenCaptureProvider,
  Target,
} from "@pointy/shared/overlay";
import { findDisplay } from "../coords";
import type { ResolvedTarget } from "../TargetResolver";
import { normaliseInCrop, planCrop } from "./anatomyCrop";
import type { ImageSource } from "./falClient";
import { nearestIcon } from "./iconMatch";

export interface ExplainerState {
  body: ExplainerBody;
}

export interface ExplainerLoadHooks {
  /** Hide overlays while capturing (only used when captures would include them). */
  withHidden: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Body changed: re-render. */
  onUpdate: () => void;
  /** An image slot finished: panel index (compare: 0 = left, 1 = right). */
  onImage: (panel: number, ok: boolean) => void;
  resolveRegion: (t: Target) => Promise<ResolvedTarget | null>;
  resolveCallouts: (ts: Target[]) => Promise<(ResolvedTarget | null)[]>;
}

export interface ExplainerServiceOptions {
  captureProvider: ScreenCaptureProvider;
  imageSource?: ImageSource;
  getDisplays: () => DisplayInfo[];
  /** Hide overlay windows during anatomy capture (when content protection doesn't exclude them). */
  hideDuringCapture?: boolean;
}

const loading = (hint: string): ImageSlot => ({ status: "loading", fallbackIcon: nearestIcon(hint) });
const failed = (hint: string): ImageSlot => ({ status: "failed", fallbackIcon: nearestIcon(hint) });
const DEFAULT_ASPECT = 16 / 9;

export class ExplainerService {
  constructor(private readonly opts: ExplainerServiceOptions) {}

  /** Initial body: everything that can be shown instantly, async parts as loading slots. */
  create(spec: ExplainerSpec): ExplainerState {
    switch (spec.kind) {
      case "verdict":
        return { body: { kind: "verdict", tone: spec.tone, reasons: [...spec.reasons] } };
      case "sequence":
        return { body: { kind: "sequence", steps: spec.steps.map((s) => ({ icon: s.icon, caption: s.caption })) } };
      case "compare": {
        const side = (s: typeof spec.left) => ({
          title: s.title,
          points: [...s.points],
          image: s.imagePrompt ? loading(`${s.title} ${s.imagePrompt}`) : null,
        });
        return { body: { kind: "compare", left: side(spec.left), right: side(spec.right) } };
      }
      case "concept":
        return {
          body: {
            kind: "concept",
            panels: spec.panels.map((p) => ({ caption: p.caption, image: loading(`${p.caption} ${p.imagePrompt}`) })),
          },
        };
      case "anatomy":
        return {
          body: {
            kind: "anatomy",
            image: { status: "loading", fallbackIcon: "click" },
            aspect: DEFAULT_ASPECT,
            callouts: spec.callouts.map((c, i) => ({ n: i + 1, label: c.label, nx: 0, ny: 0, nw: 0, nh: 0, inside: false })),
          },
        };
    }
  }

  body(state: ExplainerState): ExplainerBody {
    return state.body;
  }

  /**
   * A "ready" picture couldn't be decoded by the renderer: show its large fallback icon instead.
   * Returns false if that panel wasn't a ready picture (unknown panel, or already handled).
   */
  markFailed(state: ExplainerState, panel: number): boolean {
    const fail = (slot: ImageSlot | null | undefined): ImageSlot | null =>
      slot?.status === "ready" ? { status: "failed", fallbackIcon: slot.fallbackIcon ?? "photo" } : null;
    const b = state.body;
    if (b.kind === "concept") {
      const next = fail(b.panels[panel]?.image);
      if (!next) return false;
      state.body = { ...b, panels: b.panels.map((p, i) => (i === panel ? { ...p, image: next } : p)) };
      return true;
    }
    if (b.kind === "compare") {
      const side = panel === 0 ? "left" : panel === 1 ? "right" : null;
      const next = side ? fail(b[side].image) : null;
      if (!side || !next) return false;
      state.body = { ...b, [side]: { ...b[side], image: next } };
      return true;
    }
    if (b.kind === "anatomy" && panel === 0) {
      const next = fail(b.image);
      if (!next) return false;
      state.body = { ...b, image: next };
      return true;
    }
    return false;
  }

  /** Start async loading. Never throws; failures become "failed" slots + events. */
  load(state: ExplainerState, spec: ExplainerSpec, hooks: ExplainerLoadHooks): void {
    switch (spec.kind) {
      case "concept":
        spec.panels.forEach((p, i) => {
          void this.loadImage(p.imagePrompt, `${p.caption} ${p.imagePrompt}`, (slot) => {
            if (state.body.kind !== "concept") return;
            const panels = state.body.panels.map((panel, j) => (j === i ? { ...panel, image: slot } : panel));
            state.body = { ...state.body, panels };
          }, i, hooks);
        });
        return;
      case "compare":
        (["left", "right"] as const).forEach((sideName, i) => {
          const side = spec[sideName];
          if (!side.imagePrompt) return;
          void this.loadImage(side.imagePrompt, `${side.title} ${side.imagePrompt}`, (slot) => {
            if (state.body.kind !== "compare") return;
            state.body = { ...state.body, [sideName]: { ...state.body[sideName], image: slot } };
          }, i, hooks);
        });
        return;
      case "anatomy":
        void this.loadAnatomy(state, spec, hooks);
        return;
      case "sequence":
      case "verdict":
        return;
    }
  }

  private async loadImage(
    prompt: string,
    hint: string,
    apply: (slot: ImageSlot) => void,
    panel: number,
    hooks: ExplainerLoadHooks,
  ): Promise<void> {
    const result = this.opts.imageSource
      ? await this.opts.imageSource.getImage(prompt).catch(() => ({ ok: false as const }))
      : ({ ok: false } as const);
    apply(result.ok ? { status: "ready", src: result.dataUrl, fallbackIcon: nearestIcon(hint) } : failed(hint));
    hooks.onUpdate();
    hooks.onImage(panel, result.ok);
  }

  private async loadAnatomy(state: ExplainerState, spec: AnatomySpec, hooks: ExplainerLoadHooks): Promise<void> {
    const setBody = (patch: Partial<Extract<ExplainerBody, { kind: "anatomy" }>>) => {
      if (state.body.kind !== "anatomy") return;
      state.body = { ...state.body, ...patch };
      hooks.onUpdate();
    };
    try {
      const region = await hooks.resolveRegion(spec.region);
      const display = region ? findDisplay(region.displayId, this.opts.getDisplays()) : null;
      if (!region || !display) throw new Error("anatomy region not found");
      const plan = planCrop(region.bounds, display);
      const targets = await hooks.resolveCallouts(spec.callouts.map((c) => c.target));
      const callouts: AnatomyCallout[] = spec.callouts.map((c, i) => {
        const t = targets[i];
        const n = t ? normaliseInCrop(t.bounds, plan) : { nx: 0, ny: 0, nw: 0, nh: 0, inside: false };
        return { n: i + 1, label: c.label, ...n };
      });
      setBody({ callouts, aspect: plan.px.width / plan.px.height });

      const capture = () => this.opts.captureProvider.captureRegion(plan.displayId, plan.region);
      const png = this.opts.hideDuringCapture ? await hooks.withHidden(capture) : await capture();
      setBody({ image: { status: "ready", src: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } });
      hooks.onImage(0, true);
    } catch {
      setBody({ image: { status: "failed", fallbackIcon: "click" } });
      hooks.onImage(0, false);
    }
  }
}
