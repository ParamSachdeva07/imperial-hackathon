import { describe, expect, it, vi } from "vitest";
import { handleServerEvent, type RealtimeDeps } from "./realtimeEvents";

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

  it("starts an overlay turn when the user starts speaking and logs transcripts", async () => {
    const d = deps();
    await handleServerEvent({ type: "input_audio_buffer.speech_started" }, d);
    expect(d.turnStart).toHaveBeenCalledWith("turn-1");
    await handleServerEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "where is send?" }, d);
    expect(d.log).toHaveBeenCalledWith("you", "where is send?");
  });
});
