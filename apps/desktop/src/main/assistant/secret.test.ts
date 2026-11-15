import { describe, expect, it } from "vitest";
import { describeRealtimeConfig, assistantSessionConfig } from "./realtimeProtocol";
import { mintAssistantSecret } from "./secret";

const ok = () => new Response(JSON.stringify({ value: "ek_x", expires_at: 5 }), { status: 200 });
const bad = () => new Response(JSON.stringify({ error: { message: "Invalid value: 'minimal'", param: "session.reasoning.effort" } }), { status: 400 });

describe("mintAssistantSecret effort", () => {
  it("sends session.reasoning.effort", async () => {
    const bodies: Array<{ session: { reasoning?: unknown } }> = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return ok(); }) as unknown as typeof fetch;
    const r = await mintAssistantSecret({ apiKey: "k", instructions: "i", tools: [], fetch: fetchFn, model: "m", effort: "minimal" });
    expect(bodies[0]!.session.reasoning).toEqual({ effort: "minimal" });
    expect(r.effort).toBe("minimal");
  });
  it("retries once with low when effort is rejected", async () => {
    const efforts: unknown[] = [];
    let i = 0;
    const fetchFn = (async (_u: string, init: RequestInit) => { efforts.push(JSON.parse(String(init.body)).session.reasoning?.effort); return i++ === 0 ? bad() : ok(); }) as unknown as typeof fetch;
    const r = await mintAssistantSecret({ apiKey: "k", instructions: "i", tools: [], fetch: fetchFn, effort: "minimal" });
    expect(efforts).toEqual(["minimal", "low"]);
    expect(r.effort).toBe("low");
  });
  it("does not retry unrelated errors", async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }); }) as unknown as typeof fetch;
    await expect(mintAssistantSecret({ apiKey: "k", instructions: "i", tools: [], fetch: fetchFn, effort: "minimal" })).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });
});

describe("protocol config", () => {
  it("omits reasoning without effort; describes config", () => {
    expect(assistantSessionConfig({ instructions: "i", tools: [] })).not.toHaveProperty("reasoning");
    expect(describeRealtimeConfig("m", "low")).toBe("model=m, effort=low");
  });
});
