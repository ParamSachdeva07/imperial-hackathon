import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GESTURE_MODEL_URL, GESTURE_WASM_URL, mimeFor, parseAssetUrl, resolveAssetRequest } from "./assetResolver";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "gest-assets-"));
  const root = join(base, "public");
  mkdirSync(join(root, "mediapipe-wasm"), { recursive: true });
  mkdirSync(join(root, "models"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  writeFileSync(join(root, "mediapipe-wasm", "a.wasm"), "wasm");
  writeFileSync(join(root, "mediapipe-wasm", "loader.js"), "js");
  writeFileSync(join(root, "models", "gesture_recognizer.task"), "model");
  writeFileSync(join(root, "other", "x.js"), "no");
  writeFileSync(join(base, "secret.txt"), "secret");
  symlinkSync(join(base, "secret.txt"), join(root, "models", "link.task"));
  return root;
}

describe("mimeFor", () => {
  it("maps known extensions", () => {
    expect(mimeFor("a.wasm")).toBe("application/wasm");
    expect(mimeFor("a.JS")).toBe("text/javascript");
    expect(mimeFor("m.task")).toBe("application/octet-stream");
    expect(mimeFor("m.bin")).toBe("application/octet-stream");
  });
});

describe("parseAssetUrl", () => {
  it("accepts allow-listed folders", () => {
    expect(parseAssetUrl(`${GESTURE_WASM_URL}/vision_wasm_internal.wasm`)).toEqual({
      ok: true,
      segments: ["mediapipe-wasm", "vision_wasm_internal.wasm"],
    });
    expect(parseAssetUrl(GESTURE_MODEL_URL).ok).toBe(true);
  });
  it.each([
    "pointy-gestures-assets://assets/models/../../x",
    "pointy-gestures-assets://assets/models/%2e%2e/x",
    "pointy-gestures-assets://assets/models/%2E%2E%2Fx",
    "pointy-gestures-assets://assets/models/a%5cb",
    "pointy-gestures-assets://assets/models/a%00",
    "pointy-gestures-assets://assets/models/%252e%252e/x",
    "pointy-gestures-assets://assets/models//x",
    "pointy-gestures-assets://assets/models/",
  ])("rejects %s", (u) => {
    const r = parseAssetUrl(u);
    expect(r.ok).toBe(false);
  });
  it("404s other folders and hosts, 400s garbage", () => {
    expect(parseAssetUrl("pointy-gestures-assets://assets/other/x.js")).toEqual({ ok: false, status: 404 });
    expect(parseAssetUrl("pointy-gestures-assets://evil/models/x")).toEqual({ ok: false, status: 404 });
    expect(parseAssetUrl("https://assets/models/x")).toEqual({ ok: false, status: 404 });
    expect(parseAssetUrl("not a url")).toEqual({ ok: false, status: 400 });
  });
});

describe("resolveAssetRequest", () => {
  it("serves files with MIME and size", async () => {
    const root = fixture();
    const r = await resolveAssetRequest(root, "GET", `${GESTURE_WASM_URL}/a.wasm`);
    expect(r).toMatchObject({ status: 200, mime: "application/wasm", size: 4 });
    const m = await resolveAssetRequest(root, "HEAD", GESTURE_MODEL_URL);
    expect(m).toMatchObject({ status: 200, mime: "application/octet-stream" });
  });
  it("404s missing files and directories", async () => {
    const root = fixture();
    expect(await resolveAssetRequest(root, "GET", `${GESTURE_WASM_URL}/nope.wasm`)).toEqual({ status: 404 });
    expect(await resolveAssetRequest(root, "GET", `${GESTURE_WASM_URL}/sub/x`)).toEqual({ status: 404 });
    expect(await resolveAssetRequest(join(root, "missing"), "GET", GESTURE_MODEL_URL)).toEqual({ status: 404 });
  });
  it("only allows GET and HEAD", async () => {
    const root = fixture();
    expect(await resolveAssetRequest(root, "POST", GESTURE_MODEL_URL)).toEqual({ status: 405 });
  });
  it("refuses symlinks escaping the root", async () => {
    const root = fixture();
    expect(await resolveAssetRequest(root, "GET", "pointy-gestures-assets://assets/models/link.task")).toEqual({ status: 403 });
  });
  it("refuses traversal", async () => {
    const root = fixture();
    expect(await resolveAssetRequest(root, "GET", "pointy-gestures-assets://assets/models/../other/x.js")).toEqual({ status: 404 }); // URL parser collapses ..; not allow-listed
  });
});
