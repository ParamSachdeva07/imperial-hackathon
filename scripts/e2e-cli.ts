/**
 * Quality gate: launch the built dev app (overlay + fixture), run EVERY spec §8.1 CLI command
 * against the fixture window, and assert the results.
 *   npm run e2e        (builds first)
 * Checks: ToolResults, overlay.shown latency for explainer cards (≤ 300 ms), anchors following a
 * simulated move, step advancing, clear("all"), and the dev server rejecting requests without
 * the token.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { delay } from "@pointy/shared/node/env";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const cli = join(root, "node_modules/.bin/pointy-draw");
// Isolated port + connection file, so e2e never collides with a running dev/voice session.
const devFile = join(homedir(), ".pointy", "dev-server.e2e.json");
process.env.POINTY_DEV_FILE = devFile;
process.env.POINTY_DEV_PORT = process.env.POINTY_E2E_PORT ?? "47616";
const electron = join(root, "node_modules/.bin/electron");

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!cond) failures += 1;
};

function draw(...args: string[]): { code: number; json: Record<string, unknown> | null; out: string } {
  const r = spawnSync(cli, args, { cwd: root, encoding: "utf8", timeout: 20_000 });
  const out = (r.stdout ?? "").trim();
  let json: Record<string, unknown> | null;
  try {
    json = JSON.parse(out) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { code: r.status ?? -1, json, out: out || (r.stderr ?? "") };
}

const result = (r: ReturnType<typeof draw>) => (r.json?.result ?? {}) as { ok?: boolean; visible?: boolean; overlayId?: string; resolvedBounds?: { x: number } };
const sleep = delay;

async function main() {
  rmSync(devFile, { force: true });
  const app = spawn(electron, ["."], { cwd: join(root, "apps/desktop"), env: { ...process.env, POINTY_AVATAR_RECT: "none", POINTY_AVATAR: "mock" }, stdio: "ignore" });
  try {
    for (let i = 0; i < 60 && !existsSync(devFile); i++) await sleep(250);
    check("app started and dev server is up", existsSync(devFile));
    // Wait for the fixture to report its elements.
    let elements: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = draw("elements");
      try {
        elements = JSON.parse(r.out) as string[];
      } catch {
        elements = [];
      }
      if (elements.includes("fixture.sendButton")) break;
      await sleep(250);
    }
    check("fixture reports its elements", elements.includes("fixture.sendButton") && elements.includes("fixture.attach"), elements.length);

    // --- spec §8.1 commands, verbatim ---
    let r = draw("highlight", "--rect", "100,200,300,80", "--style", "spotlight", "--label", "Your photos", "--wait-shown");
    check("highlight --rect … --style spotlight --label", result(r).ok === true && result(r).visible === true && r.json?.shownMs !== null, r.json);

    r = draw("highlight", "--element", "fixture.sendButton", "--tone", "warning", "--wait-shown");
    const hl = result(r);
    check("highlight --element fixture.sendButton --tone warning", hl.ok === true && hl.visible === true, r.json);

    // sim move: the warning highlight must follow the send button.
    const before = hl.resolvedBounds?.x ?? NaN;
    r = draw("sim", "move", "fixture.sendButton", "40,0");
    check("sim move fixture.sendButton 40,0", r.code === 0, r.out);
    await sleep(500);
    const state = JSON.parse(draw("state").out) as { id: string; bounds: { x: number } | null; state: string }[];
    const moved = state.find((s) => s.id === hl.overlayId);
    check("highlight followed the moved element (+40)", !!moved && Math.abs((moved.bounds?.x ?? 0) - (before + 40)) < 1, moved);
    draw("sim", "restore");


    r = draw("point", "--element", "fixture.attach", "--motion", "double_tap", "--wait-shown");
    check("point --element fixture.attach --motion double_tap", result(r).ok === true && result(r).visible === true, r.json);

    r = draw("steps", "fixture.newEmail:New email", "fixture.to:Who to", "fixture.send:Send", "--wait-shown");
    const steps = result(r);
    check('steps fixture.newEmail:"New email" fixture.to:"Who to" fixture.send:"Send"', steps.ok === true && steps.visible === true, r.json);

    r = draw("explainer", "--file", "examples/compare-scam.json", "--wait-shown");
    const shownMs = r.json?.shownMs as number | null;
    check("explainer --file examples/compare-scam.json", result(r).ok === true && result(r).visible === true, r.json);
    check("explainer card shown within 300 ms", typeof shownMs === "number" && shownMs <= 300, shownMs);

    // steps: advance by selection and by tool
    draw("select", "fixture.newEmail");
    r = draw("advance", steps.overlayId ?? "");
    check("advance_step moves the step guide", result(r).ok === true, r.json);

    // other explainer kinds
    for (const f of ["examples/sequence-attach.json", "examples/anatomy-toolbar.json", "examples/concept-cloud.json"]) {
      r = draw("explainer", "--file", f, "--wait-shown");
      const ms = r.json?.shownMs as number | null;
      check(`explainer ${f} (shown in ${ms} ms)`, result(r).ok === true && typeof ms === "number" && ms <= 300, r.json);
    }

    // errors are reported, not thrown
    r = draw("highlight", "--element", "fixture.doesNotExist");
    check("missing element → visible:false target_not_found", result(r).visible === false && (r.json?.result as { reason?: string })?.reason === "target_not_found", r.json);

    r = draw("clear", "all");
    check("clear all", result(r).ok === true, r.json);
    await sleep(500);
    const after = JSON.parse(draw("state").out) as unknown[];
    check("everything faded out and removed after clear all", after.length === 0, after);

    // dev server security: no token → 403
    const conn = JSON.parse(readFileSync(devFile, "utf8")) as { port: number };
    const res = await fetch(`http://127.0.0.1:${conn.port}/state`);
    check("dev server rejects requests without the token", res.status === 403, res.status);
  } finally {
    app.kill();
  }
  console.log(failures === 0 ? "\nE2E: all checks passed" : `\nE2E: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
