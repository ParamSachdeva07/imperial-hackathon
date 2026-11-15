import { describe, expect, it } from "vitest";
import { parseGestureConfig, systemMouseOptions } from "./gestureConfig";

describe("parseGestureConfig", () => {
  it("disables the dwell click by default", () => {
    expect(parseGestureConfig({})).toEqual({
      config: { clickEnabled: false },
      applied: ["click=off"],
      warnings: [],
    });
  });
  it("POINTY_GESTURES_CLICK=1 restores the dwell click", () => {
    expect(parseGestureConfig({ POINTY_GESTURES_CLICK: "1" })).toEqual({
      config: {},
      applied: ["click=on"],
      warnings: [],
    });
  });
  it("parses the zone and numeric tunables", () => {
    const r = parseGestureConfig({
      POINTY_GESTURES_ZONE: "0.1, 0.25,0.9,0.8",
      POINTY_GESTURES_FINGER_EXTEND_RATIO: "1.05",
      POINTY_GESTURES_SCROLL_GAIN: "2",
    });
    expect(r.config).toEqual({
      clickEnabled: false,
      activeZone: { x0: 0.1, y0: 0.25, x1: 0.9, y1: 0.8 },
      fingerExtendRatio: 1.05,
      scrollGain: 2,
    });
    expect(r.warnings).toEqual([]);
  });
  it("ignores invalid values with a warning", () => {
    const r = parseGestureConfig({
      POINTY_GESTURES_ZONE: "0.5,0.5,0.52,0.9",
      POINTY_GESTURES_DEADBAND: "abc",
      POINTY_GESTURES_POSE_STABLE_MS: "-1",
      POINTY_GESTURES_SCROLL_GAIN: "",
    });
    expect(r.config).toEqual({ clickEnabled: false });
    expect(r.warnings).toHaveLength(3);
  });
});

describe("systemMouseOptions", () => {
  it("passes click false by default and true on opt-in", () => {
    const log = () => {};
    expect(systemMouseOptions({}, log)).toEqual({ log, click: false });
    expect(systemMouseOptions({ POINTY_GESTURES_CLICK: "1" }, log).click).toBe(
      true,
    );
  });
});
