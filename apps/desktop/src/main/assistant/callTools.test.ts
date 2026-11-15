import { describe, expect, it } from "vitest";
import { FakeClock } from "../overlay/testing/fakeClock";
import type { AssistantStatus } from "./status";
import { END_CALL_TOOL, closeAfterGoodbye } from "./callTools";

describe("end_call", () => {
  it("closes only after the goodbye has finished being spoken", () => {
    const clock = new FakeClock();
    let status: AssistantStatus = "thinking";
    let closed = 0;
    closeAfterGoodbye({ status: () => status, close: () => closed++, clock });
    clock.advance(2500);
    expect(closed).toBe(0);
    status = "speaking";
    clock.advance(3000);
    expect(closed).toBe(0);
    status = "listening";
    clock.advance(300);
    expect(closed).toBe(1);
  });

  it("does not wait for ever on a stuck answer, and does nothing if the call is already over", () => {
    const clock = new FakeClock();
    let closed = 0;
    closeAfterGoodbye({ status: () => "speaking", close: () => closed++, clock });
    clock.advance(16_000);
    expect(closed).toBe(1);
    closeAfterGoodbye({ status: () => "idle", close: () => closed++, clock });
    clock.advance(16_000);
    expect(closed).toBe(1);
  });

  it("takes no arguments", () => {
    expect(END_CALL_TOOL.parameters.properties).toEqual({});
  });
});
