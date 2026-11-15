import { describe, expect, it, vi } from "vitest";
import type { SelectionSnapshot } from "@pointy/shared/context/selection";
import { handleServerEvent, selectionItems, type RealtimeDeps } from "./realtimeEvents";

function deps(): RealtimeDeps & { sent: object[] } {
  const sent: object[] = [];
  return {
    sent,
    send: (e) => sent.push(e),
    callTool: vi.fn(async (name: string) => (name === "boom" ? Promise.reject(new Error("x")) : { ok: true, visible: true, overlayId: "hl_1" })),
    turnStart: vi.fn(),
    log: vi.fn(),
    newTurnId: () => "turn-1",
  };
}

describe("realtime event handling", () => {
  it("runs every function call in response.done, returns outputs, then asks for one response", async () => {
    const d = deps();
    await handleServerEvent(
      {
        type: "response.done",
        response: {
          output: [
            { type: "message" },
            { type: "function_call", name: "highlight", call_id: "c1", arguments: '{"target":{"kind":"element","elementId":"fixture.send"}}' },
            { type: "function_call", name: "boom", call_id: "c2", arguments: "{}" },
          ],
        },
      },
      d,
    );
    expect(d.callTool).toHaveBeenCalledWith("highlight", { target: { kind: "element", elementId: "fixture.send" } });
    expect(d.sent).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ ok: true, visible: true, overlayId: "hl_1" }) } },
      expect.objectContaining({ type: "conversation.item.create", item: expect.objectContaining({ call_id: "c2" }) }),
      { type: "response.create" },
    ]);
  });

  it("does not trigger a response when there are no function calls", async () => {
    const d = deps();
    await handleServerEvent({ type: "response.done", response: { output: [{ type: "message" }] } }, d);
    expect(d.sent).toEqual([]);
  });

  it("refreshes the on-screen element list with a session.update on each user turn", async () => {
    const d = { ...deps(), instructions: async () => "fresh instructions" };
    await handleServerEvent({ type: "input_audio_buffer.speech_started" }, d);
    expect(d.sent).toEqual([{ type: "session.update", session: { type: "realtime", instructions: "fresh instructions" } }]);
  });

  it("starts an overlay turn when the user starts speaking and logs transcripts", async () => {
    const d = deps();
    await handleServerEvent({ type: "input_audio_buffer.speech_started" }, d);
    expect(d.turnStart).toHaveBeenCalledWith("turn-1");
    await handleServerEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "where is send?" }, d);
    expect(d.log).toHaveBeenCalledWith("you", "where is send?");
  });
});

function snap(fullChars = 100, focusChars = 100, kind: "region" | "point" = "region"): SelectionSnapshot {
  const img = (n: number, w: number) => ({ mime: "image/jpeg" as const, dataUrl: `data:image/jpeg;base64,${"A".repeat(n)}`, width: w, height: w });
  return {
    id: "s1",
    kind,
    capturedAt: 1,
    displayId: "1",
    regionGlobal: { x: 10, y: 20, width: 300, height: 200 },
    ...(kind === "region" ? { polygonGlobal: [{ x: 10, y: 20 }, { x: 310, y: 20 }, { x: 310, y: 220 }] } : { pointGlobal: { x: 160, y: 120 } }),
    full: { ...img(fullChars, 1280), markedRegion: { x: 0, y: 0, width: 0.2, height: 0.2 } },
    focus: img(focusChars, 768),
  };
}

describe("selectionItems", () => {
  it("builds one user message with text, full then focus image, and no response.create", () => {
    const { events } = selectionItems(snap(), { maxMessageBytes: 100_000 });
    expect(events).toHaveLength(1);
    const item = (events[0] as { item: { role: string; content: { type: string; text?: string; image_url?: string; detail?: string }[] } }).item;
    expect(item.role).toBe("user");
    expect(item.content.map((c) => c.type)).toEqual(["input_text", "input_image", "input_image"]);
    expect(item.content[0]?.text).toContain("[selection]");
    expect(item.content[0]?.text).toContain("a region");
    expect(item.content[0]?.text).toContain("bbox x=10, y=20, 300x200");
    expect(item.content[0]?.text).toContain("[[10,20],[310,20],[310,220]]");
    expect(item.content[1]?.image_url).toBe(snap().full.dataUrl);
    expect(item.content[2]?.detail).toBe("auto");
  });

  it("describes a point selection", () => {
    const { events } = selectionItems(snap(10, 10, "point"));
    expect(JSON.stringify(events)).toContain("a point");
    expect(JSON.stringify(events)).toContain("point (160, 120)");
  });

  it("falls back to focus then full in separate messages when the combined one is too big", () => {
    const { events, note } = selectionItems(snap(5000, 5000), { maxMessageBytes: 7000 });
    expect(events).toHaveLength(2);
    expect(note).toMatch(/separately/);
    for (const e of events) expect(JSON.stringify(e).length).toBeLessThanOrEqual(7000);
  });

  it("sends focus only when full alone is too big, and text only when nothing fits; never exceeds the limit", () => {
    const a = selectionItems(snap(50_000, 2000), { maxMessageBytes: 6000 });
    expect(a.events).toHaveLength(1);
    expect(a.note).toMatch(/focus only/);
    const b = selectionItems(snap(50_000, 50_000), { maxMessageBytes: 6000 });
    expect(b.events).toHaveLength(1);
    expect(JSON.stringify(b.events[0])).not.toContain("input_image");
    for (const x of [a, b]) for (const e of x.events) expect(JSON.stringify(e).length).toBeLessThanOrEqual(6000);
  });

  it("defaults to 256KB when the limit is unknown", () => {
    expect(selectionItems(snap(100, 100), {}).events).toHaveLength(1);
    expect(selectionItems(snap(200_000, 200_000), {}).events).toHaveLength(2);
    expect(selectionItems(snap(400_000, 400_000), {}).events).toHaveLength(1);
  });

  it("says the whole-screen view follows when the images are split across two messages", () => {
    const { events } = selectionItems(snap(200_000, 200_000), {});
    expect(events).toHaveLength(2);
    const first = JSON.stringify(events[0]);
    expect(first).toContain("follows in the next message");
    expect(first).not.toContain("could not be sent");
  });
});
