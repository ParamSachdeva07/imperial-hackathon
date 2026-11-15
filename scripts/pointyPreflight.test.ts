import { describe, expect, it } from "vitest";
import {
  anamEnv,
  isFinderDuplicate,
  isStale,
  newestMtime,
  parseArgs,
  parseEnvKeys,
  pointyEnv,
  runPreflight,
  type MtimeIo,
  type PreflightDeps,
} from "./pointyPreflight.mjs";

const ROOT = "/r";

function fakeIo(files: Record<string, number>): MtimeIo {
  return {
    readdir(dir) {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const seen = new Map<string, boolean>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        seen.set(head!, tail.length > 0);
      }
      if (seen.size === 0) throw new Error("ENOENT");
      return [...seen].map(([name, isDir]) => ({ name, isDir }));
    },
    mtime: (p) => files[p] ?? 0,
  };
}

const ALL_FILES: Record<string, number> = {
  "/r/.env": 1,
  "/r/anam-overlay/backend/.env": 1,
  "/r/anam-overlay/backend/.venv/bin/python": 1,
  "/r/anam-overlay/backend/.venv/bin/uvicorn": 1,
  "/r/packages/gestures/.cache/public/models/gesture_recognizer.task": 1,
  "/r/packages/gestures/.cache/public/mediapipe-wasm": 1,
};

function deps(over: Partial<PreflightDeps> & { texts?: Record<string, string>; present?: string[]; mtimes?: Record<string, number> } = {}): PreflightDeps {
  const present = new Set(over.present ?? Object.keys(ALL_FILES));
  const texts = over.texts ?? { "/r/.env": "OPENAI_API_KEY=sk-x\n", "/r/anam-overlay/backend/.env": "ANAM_API_KEY=abc\n" };
  const mtimes = over.mtimes ?? {
    "/r/apps/desktop/src/a.ts": 10,
    "/r/apps/desktop/out/main/index.js": 20,
    "/r/anam-overlay/src/a.ts": 10,
    "/r/anam-overlay/dist-electron/main.mjs": 20,
    "/r/anam-overlay/dist/index.html": 20,
  };
  return {
    root: ROOT,
    env: {},
    nodeVersion: "v22.1.0",
    exists: (p) => present.has(p),
    readText: (p) => texts[p] ?? "",
    io: fakeIo(mtimes),
    portState: async () => "free",
    ...over,
  };
}

const find = (r: Awaited<ReturnType<typeof runPreflight>>, id: string) => r.checks.find((c) => c.id === id);

describe("helpers", () => {
  it("detects Finder duplicates", () => {
    expect(isFinderDuplicate("index 2.ts")).toBe(true);
    expect(isFinderDuplicate("overlay 2")).toBe(true);
    expect(isFinderDuplicate("package 3.json")).toBe(true);
    expect(isFinderDuplicate("index.ts")).toBe(false);
    expect(isFinderDuplicate("vite-env.d.ts")).toBe(false);
  });
  it("parses env keys by presence only", () => {
    const k = parseEnvKeys("A=1\nexport B='x'\nC=\nD=\"\"\n# E=1\n  F = 2\n");
    expect([...k].sort()).toEqual(["A", "B", "F"]);
  });
  it("newestMtime ignores duplicates and node_modules", () => {
    const io = fakeIo({ "/s/a.ts": 5, "/s/a 2.ts": 99, "/s/node_modules/x.js": 99, "/s/d/b.ts": 7 });
    expect(newestMtime("/s", io)).toBe(7);
  });
  it("isStale compares src vs out", () => {
    const io = fakeIo({ "/s/a.ts": 30, "/o/x.js": 20 });
    expect(isStale({ srcDirs: ["/s"], outDir: "/o", io })).toBe(true);
    expect(isStale({ srcDirs: ["/s"], outDir: "/missing", io })).toBe(true);
    expect(isStale({ srcDirs: ["/s"], outDir: "/o", io: fakeIo({ "/s/a.ts": 10, "/o/x.js": 20 }) })).toBe(false);
  });
  it("parses args and builds envs", () => {
    expect(parseArgs(["--no-anam", "--debug", "--wat"])).toMatchObject({ noAnam: true, debug: true, unknown: ["--wat"] });
    expect(pointyEnv({ ELECTRON_RUN_AS_NODE: "1" }, { debug: false })).toMatchObject({ POINTY_MODE: "production", POINTY_GESTURES: "1", POINTY_GESTURES_MOUSE: "1" });
    expect(pointyEnv({ POINTY_GESTURES: "0", POINTY_GESTURES_MOUSE: "0" }, { debug: false })).toMatchObject({ POINTY_GESTURES: "0", POINTY_GESTURES_MOUSE: "0" });
    expect(pointyEnv({}, { debug: true })).toMatchObject({ POINTY_DEV_SERVER: "1", POINTY_GESTURES_SHOW: "1" });
    expect(pointyEnv({ ELECTRON_RUN_AS_NODE: "1" }, { debug: false }).ELECTRON_RUN_AS_NODE).toBeUndefined();
    const a = anamEnv({ VITE_ANAM_API_KEY: "k" });
    expect(a.ANAM_SPEAK_ONLY).toBe("1");
    expect(a.VITE_ANAM_API_KEY).toBeUndefined();
  });
});

describe("runPreflight", () => {
  it("passes when everything is in place", async () => {
    const r = await runPreflight(deps());
    expect(r.ok).toBe(true);
    expect(r.needsBuild).toEqual({ desktop: false, anam: false });
    expect(r.needsGestureAssets).toBe(false);
  });
  it("fails on old node", async () => {
    const r = await runPreflight(deps({ nodeVersion: "v20.11.0" }));
    expect(find(r, "node")?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });
  it("fails on missing keys without printing values", async () => {
    const r = await runPreflight(deps({ texts: { "/r/.env": "", "/r/anam-overlay/backend/.env": "OTHER=1" } }));
    expect(find(r, "openai-key")?.ok).toBe(false);
    expect(find(r, "anam-key")?.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("sk-x");
  });
  it("accepts OPENAI_API_KEY from the environment", async () => {
    const r = await runPreflight(deps({ texts: {}, env: { OPENAI_API_KEY: "x" } }));
    expect(find(r, "openai-key")?.ok).toBe(true);
  });
  it("suggests the uv command when the venv lacks uvicorn", async () => {
    const present = Object.keys(ALL_FILES).filter((p) => !p.endsWith("uvicorn"));
    const r = await runPreflight(deps({ present }));
    const c = find(r, "venv");
    expect(c?.ok).toBe(false);
    expect(c?.fix).toContain("uv venv --clear --python 3.12 backend/.venv");
  });
  it("flags missing gesture assets as fetchable, not fatal", async () => {
    const present = Object.keys(ALL_FILES).filter((p) => !p.includes("gestures"));
    const r = await runPreflight(deps({ present }));
    expect(r.needsGestureAssets).toBe(true);
    expect(r.ok).toBe(true);
  });
  it("does not require or fetch gesture assets when gestures are disabled", async () => {
    const present = Object.keys(ALL_FILES).filter((p) => !p.includes("gestures"));
    const r = await runPreflight(deps({ present, env: { POINTY_GESTURES: "0" } }));
    expect(r.needsGestureAssets).toBe(false);
    expect(find(r, "gesture-assets")?.ok).toBe(true);
    expect(r.ok).toBe(true);
  });
  it("port states", async () => {
    expect((await runPreflight(deps({ portState: async () => "busy" }))).ok).toBe(false);
    const ours = await runPreflight(deps({ portState: async () => "ours" }));
    expect(ours.ok).toBe(true);
    expect(ours.backendRunning).toBe(true);
  });
  it("detects stale builds, ignoring duplicates, and honours --rebuild", async () => {
    const mtimes = {
      "/r/apps/desktop/src/a.ts": 30,
      "/r/apps/desktop/src/a 2.ts": 999,
      "/r/apps/desktop/out/main/index.js": 20,
      "/r/anam-overlay/src/a.ts": 10,
      "/r/anam-overlay/src/b 2.ts": 999,
      "/r/anam-overlay/dist-electron/main.mjs": 20,
      "/r/anam-overlay/dist/index.html": 20,
    };
    const r = await runPreflight(deps({ mtimes }));
    expect(r.needsBuild).toEqual({ desktop: true, anam: false });
    const r2 = await runPreflight(deps({ rebuild: true }));
    expect(r2.needsBuild).toEqual({ desktop: true, anam: true });
  });
  it("--no-anam skips anam checks", async () => {
    const r = await runPreflight(deps({ noAnam: true, texts: { "/r/.env": "OPENAI_API_KEY=1" }, portState: async () => "busy" }));
    expect(find(r, "anam-key")).toBeUndefined();
    expect(find(r, "port")).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.needsBuild.anam).toBe(false);
  });
});
