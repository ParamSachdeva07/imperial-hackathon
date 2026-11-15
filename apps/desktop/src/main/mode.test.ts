import { describe, expect, it } from "vitest";
import { resolveMode } from "./mode";

describe("resolveMode", () => {
  it("dev defaults", () => {
    expect(resolveMode({}, false)).toEqual({
      production: false, fixture: true, voiceTestWindow: false, devServer: true, devLogging: true,
    });
  });
  it("dev flags", () => {
    const m = resolveMode({ POINTY_NO_FIXTURE: "1", POINTY_VOICE: "1" }, false);
    expect(m.fixture).toBe(false);
    expect(m.voiceTestWindow).toBe(true);
  });
  it("packaged non-production has no dev server/logging", () => {
    const m = resolveMode({}, true);
    expect(m.devServer).toBe(false);
    expect(m.devLogging).toBe(false);
  });
  it("production disables dev things", () => {
    const m = resolveMode({ POINTY_MODE: "production", POINTY_VOICE: "1" }, false);
    expect(m).toEqual({ production: true, fixture: false, voiceTestWindow: false, devServer: false, devLogging: false });
  });
  it("production dev server opt-in", () => {
    expect(resolveMode({ POINTY_MODE: "production", POINTY_DEV_SERVER: "1" }, true).devServer).toBe(true);
  });
});
