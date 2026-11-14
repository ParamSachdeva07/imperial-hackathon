import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaintedMessage, RenderItem, RenderScene, StepsItem } from "@pointy/shared/overlay/render";
import { OverlayRoot } from "./OverlayRoot";
import { OverlayScene } from "./OverlayScene";
import { calloutDot } from "./explainer/AnatomyTemplate";
import { ImageSlotView } from "./explainer/ImageSlot";
import { SCENES, DISPLAY } from "../gallery/scenes";
import { ICON_NAMES } from "./icons/Icon";
import { IconName } from "@pointy/shared/overlay/schemas";

const scene = (name: string): RenderScene => SCENES.find((s) => s.name === name)!.scene;
afterEach(cleanup);

describe("OverlayScene", () => {
  it("translates the root by the display origin", () => {
    const s: RenderScene = { ...scene("ring-labeled"), display: { ...DISPLAY, bounds: { x: 1440, y: -200, width: 1280, height: 800 } } };
    const { container } = render(<OverlayScene scene={s} reduceMotion={false} />);
    const root = container.querySelector<HTMLElement>(".overlay-root")!;
    expect(root.style.transform).toBe("translate(-1440px, 200px)");
  });

  it("renders every item kind", () => {
    const kinds: Record<string, string> = { ring: ".item-highlight", pointer: ".item-pointer", steps: ".item-steps", seq: ".item-explainer" };
    for (const [name, sel] of [["ring-labeled", kinds.ring], ["pointer-tap", kinds.pointer], ["steps", kinds.steps], ["explainer-sequence", kinds.seq]] as const) {
      const { container, unmount } = render(<OverlayScene scene={scene(name)} reduceMotion={false} />);
      expect(container.querySelector(sel!)).not.toBeNull();
      unmount();
    }
  });

  it("renders all four explainer templates and highlight styles", () => {
    for (const [name, sel] of [
      ["explainer-sequence", ".seq"], ["explainer-compare", ".cmp"], ["explainer-anatomy", ".ana"], ["explainer-concept-ready", ".concept"],
      ["spotlight-info-label", ".spotlight"], ["underline-glyph", ".underline"],
    ] as const) {
      const { container, unmount } = render(<OverlayScene scene={scene(name)} reduceMotion={false} />);
      expect(container.querySelector(sel)).not.toBeNull();
      unmount();
    }
  });

  it("marks exiting items and reduceMotion", () => {
    const { container } = render(<OverlayScene scene={scene("exiting")} reduceMotion />);
    expect(container.querySelectorAll(".item.exiting")).toHaveLength(1);
    expect(container.querySelectorAll(".item.visible")).toHaveLength(1);
    expect(container.querySelector(".overlay-root")!.classList.contains("reduce")).toBe(true);
  });

  it("shows a glyph badge when there is no label, and never colour alone", () => {
    const { container } = render(<OverlayScene scene={scene("ring-glyph")} reduceMotion={false} />);
    const glyphs = [...container.querySelectorAll("[data-glyph-badge]")].map((e) => e.getAttribute("data-glyph-badge"));
    expect(glyphs).toEqual(["info", "warning", "success"]);
  });

  it("steps: one at a time — one ring, one label, a faint hint on the next step only, no lines", () => {
    const { container } = render(<OverlayScene scene={scene("steps")} reduceMotion={false} />);
    expect(container.querySelectorAll(".step-path")).toHaveLength(0); // no dotted lines
    expect(container.querySelectorAll(".step-badge")).toHaveLength(0); // no big numbered circles
    expect(container.querySelectorAll(".item-steps .step-ring .shape-stroke")).toHaveLength(1);
    const labels = container.querySelectorAll(".item-steps .label");
    expect(labels).toHaveLength(1);
    expect(labels[0]!.textContent).toContain("Step 2 of 5 · Choose Share");
    const hints = [...container.querySelectorAll(".step-hint")];
    expect(hints.map((h) => h.getAttribute("data-step"))).toEqual(["2"]);
    expect(hints[0]!.textContent).toBe("3");
  });

  it("steps: the ring and label are the same DOM nodes when the guide advances (so they glide)", () => {
    const base = scene("steps");
    const { container, rerender } = render(<OverlayScene scene={base} reduceMotion={false} />);
    const ring = container.querySelector(".step-ring .shape-stroke");
    const labelEl = container.querySelector(".step-label .label");
    const item = base.items[0] as StepsItem;
    const advanced: StepsItem = {
      ...item,
      current: 2,
      steps: item.steps.map((s) =>
        s.index === 1
          ? { ...s, status: "past", labelBox: null }
          : s.index === 2
            ? { ...s, status: "current", badge: null, labelBox: { ...item.steps[1]!.labelBox!, text: "Step 3 of 5 · Pick a person" } }
            : s.index === 4
              ? { ...s, badge: { x: 10, y: 10 } }
              : s,
      ),
    };
    rerender(<OverlayScene scene={{ ...base, seq: base.seq + 1, items: [advanced] }} reduceMotion={false} />);
    expect(container.querySelector(".step-ring .shape-stroke")).toBe(ring);
    expect(container.querySelector(".step-label .label")).toBe(labelEl);
    expect(container.querySelector(".step-label .label")!.textContent).toContain("Step 3 of 5");
    expect([...container.querySelectorAll(".step-hint")].map((h) => h.getAttribute("data-step"))).toEqual(["4"]);
  });

  it("steps: completed shows a green ring and “All done”", () => {
    const { container } = render(<OverlayScene scene={scene("steps-done")} reduceMotion={false} />);
    expect(container.querySelector(".item-steps .step-ring .ring.tone-success")).not.toBeNull();
    expect(container.querySelector(".item-steps .label")!.textContent).toContain("All done");
    expect(container.querySelectorAll(".step-hint")).toHaveLength(0);
  });

  it("anatomy: dots at normalised positions, legend lists all callouts", () => {
    const { container } = render(<OverlayScene scene={scene("explainer-anatomy-legend-only")} reduceMotion={false} />);
    expect(container.querySelectorAll(".ana-dot")).toHaveLength(1);
    expect(container.querySelectorAll("[data-legend]")).toHaveLength(2);
    const a = calloutDot({ n: 1, label: "", nx: 0, ny: 0, nw: 0.1, nh: 0.1, inside: true }, 1.6);
    const b = calloutDot({ n: 1, label: "", nx: 0.5, ny: 0.5, nw: 0.1, nh: 0.1, inside: true }, 1.6);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeGreaterThan(a.y);
  });

  it("image slot states", () => {
    const { container, rerender } = render(<ImageSlotView slot={{ status: "loading", fallbackIcon: "cloud" }} />);
    expect(container.querySelector(".shimmer")).not.toBeNull();
    rerender(<ImageSlotView slot={{ status: "ready", src: "data:image/png;base64,AA" }} />);
    expect(container.querySelector("img")).not.toBeNull();
    rerender(<ImageSlotView slot={{ status: "failed", fallbackIcon: "lock" }} />);
    expect(container.querySelector('[data-icon="lock"]')).not.toBeNull();
    expect(container.querySelector(".shimmer")).toBeNull();
  });

  it("has an inline icon for every IconName", () => {
    for (const n of IconName.options) expect(ICON_NAMES).toContain(n);
  });
});

describe("OverlayRoot", () => {
  let push: (s: RenderScene) => void = () => {};
  const painted = vi.fn<(m: PaintedMessage) => void>();
  const ready = vi.fn();
  beforeEach(() => {
    painted.mockClear();
    ready.mockClear();
    window.pointyOverlay = {
      onScene: (cb) => {
        push = cb;
        return () => {};
      },
      onImage: () => () => {},
      onImageDrop: () => () => {},
      painted,
      ready,
    };
  });

  it("calls ready once and painted once per new id", async () => {
    render(<OverlayRoot />);
    expect(ready).toHaveBeenCalledTimes(1);
    const base = scene("exiting");
    const [a, b] = base.items as [RenderItem, RenderItem];
    act(() => push({ ...base, seq: 1, items: [a] }));
    await waitFor(() => expect(painted).toHaveBeenCalledTimes(1));
    expect(painted).toHaveBeenLastCalledWith({ seq: 1, ids: [a.id] });
    act(() => push({ ...base, seq: 2, items: [a] }));
    await new Promise((r) => setTimeout(r, 80));
    expect(painted).toHaveBeenCalledTimes(1); // no new ids
    act(() => push({ ...base, seq: 3, items: [a, b] }));
    await waitFor(() => expect(painted).toHaveBeenCalledTimes(2));
    expect(painted).toHaveBeenLastCalledWith({ seq: 3, ids: [b.id] });
    expect(screen).toBeDefined();
  });
});

describe("tone glyph badge placement", () => {
  it("moves to another corner when the preferred one is off the display", async () => {
    const { badgeCentre } = await import("./HighlightView");
    const display = { x: 0, y: 0, width: 1000, height: 800 };
    const item = {
      kind: "highlight" as const,
      id: "h",
      state: "visible" as const,
      style: "ring" as const,
      tone: "warning" as const,
      target: { bounds: { x: 900, y: 2, width: 90, height: 30 }, shape: { kind: "rect" as const } },
      label: null,
    };
    const p = badgeCentre(item, display);
    expect(p.x + 24).toBeLessThanOrEqual(1000);
    expect(p.y - 24).toBeGreaterThanOrEqual(0);
  });
});

describe("image slot decode failure", () => {
  it("swaps a ready image that fails to decode for the large fallback icon", async () => {
    const { render, fireEvent } = await import("@testing-library/react");
    const { ImageSlotView } = await import("./explainer/ImageSlot");
    const { container } = render(<ImageSlotView slot={{ status: "ready", src: "data:image/png;base64,broken" }} />);
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    expect(container.querySelector("[data-slot]")!.getAttribute("data-slot")).toBe("failed");
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("paint acks are per display", () => {
  it("only the window whose display shows an item acks it", async () => {
    const { isOnThisDisplay } = await import("./OverlayRoot");
    const item = scene("ring-labeled").items[0]!;
    expect(isOnThisDisplay(item, { x: 0, y: 0, width: 1280, height: 800 })).toBe(true);
    expect(isOnThisDisplay(item, { x: 5000, y: 0, width: 1280, height: 800 })).toBe(false);
  });
});
