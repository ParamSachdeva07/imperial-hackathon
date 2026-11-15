import { describe, expect, it } from "vitest";
import type { ExplainerItem, RenderItem } from "./render";
import { IMAGE_KEY_PREFIX, ImageKeyRegistry, rehydrateImages } from "./sceneImages";

const card = (id: string, src: string): ExplainerItem => ({
  kind: "explainer",
  id,
  state: "visible",
  title: "t",
  anchor: null,
  designSize: { width: 520, height: 300 },
  imageScale: 1,
  scale: 1,
  card: { x: 0, y: 0, width: 520, height: 300 },
  connector: null,
  body: { kind: "concept", panels: [{ caption: "c", image: { status: "ready", src } }, { caption: "d", image: { status: "loading", fallbackIcon: "cloud" } }] },
});

const srcOf = (items: RenderItem[]) => {
  const it = items[0] as ExplainerItem;
  return it.body.kind === "concept" && it.body.panels[0]!.image.status === "ready" ? it.body.panels[0]!.image.src : null;
};

describe("scene image keys", () => {
  it("replaces data URLs with stable keys and round-trips them", () => {
    const reg = new ImageKeyRegistry();
    const big = "data:image/png;base64," + "A".repeat(5000);
    const a = reg.externalize([card("ex_1", big)]);
    const b = reg.externalize([card("ex_1", big)]);
    expect(srcOf(a.items)).toMatch(new RegExp(`^${IMAGE_KEY_PREFIX}`));
    expect(srcOf(a.items)).toBe(srcOf(b.items)); // same bytes → same key
    expect(JSON.stringify(a.items).length).toBeLessThan(2000); // bytes are out of the scene
    const back = rehydrateImages(a.items, (k) => reg.src(k));
    expect(srcOf(back)).toBe(big);
  });

  it("leaves non-data srcs and other items alone, and prunes unreferenced keys", () => {
    const reg = new ImageKeyRegistry();
    const a = reg.externalize([card("ex_1", "data:image/png;base64,AAA")]);
    expect(srcOf(reg.externalize([card("ex_2", "https://x/y.png")]).items)).toBe("https://x/y.png");
    expect(reg.prune(new Set())).toEqual([...a.keys]);
    expect(reg.src([...a.keys][0]!)).toBeUndefined();
  });

  it("passes verdict cards through untouched", () => {
    const v: RenderItem = { ...card("v", "x"), body: { kind: "verdict", tone: "warning", reasons: ["a"] } };
    expect(new ImageKeyRegistry().externalize([v]).items).toEqual([v]);
  });
});
