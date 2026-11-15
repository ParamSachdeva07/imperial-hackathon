#!/usr/bin/env node
// One-command launcher: uvicorn token broker -> Anam avatar (speak-only) -> Pointy (production mode).
// Usage: npm run pointy -- [--no-anam] [--rebuild] [--debug] [--check] [--help]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKEND_PORT,
  anamEnv,
  parseArgs,
  pointyEnv,
  runPreflight,
} from "./pointyPreflight.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flags = parseArgs(process.argv.slice(2));

const HELP = `Pointy launcher

  npm run pointy -- [flags]

Starts the token broker (uvicorn :${BACKEND_PORT}), the Anam avatar (ANAM_SPEAK_ONLY=1) and Pointy
in production mode with gestures and mouse control on. Ctrl+C stops everything.

Flags
  --no-anam   do not start the broker or the Anam avatar
  --rebuild   force rebuilding apps/desktop and anam-overlay
  --debug     also enable the dev server and the gesture camera preview
  --check     run the preflight only, start nothing
  (explainer pictures are off; POINTY_IMAGES=1 turns them on and then needs FAL_KEY + the broker)
  -h, --help  show this help
`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = { pointy: "35", anam: "36", api: "33", pointyLauncher: "32", err: "31" };
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const log = (tag, msg, code = C.pointyLauncher) => {
  for (const line of String(msg).split(/\r?\n/)) if (line !== "") console.log(`${paint(code, `[${tag}]`.padEnd(9))} ${line}`);
};

const io = {
  readdir: (d) => readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
  mtime: (p) => statSync(p).mtimeMs,
};

async function portState(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      if (j && j.status === "ok") return "ours";
    }
    return "busy";
  } catch (e) {
    const code = e?.cause?.code ?? e?.code;
    return code === "ECONNREFUSED" ? "free" : e?.name === "TimeoutError" ? "busy" : "free";
  }
}

function runSync(tag, cmd, args, cwd, env = process.env) {
  log(tag, `$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
  return r.status === 0;
}

if (flags.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (flags.unknown.length) {
  console.error(`Unknown flag(s): ${flags.unknown.join(" ")}\n\n${HELP}`);
  process.exit(2);
}

log("pointy", "preflight");
const pre = await runPreflight({
  root,
  env: process.env,
  nodeVersion: process.version,
  exists: existsSync,
  readText: (p) => readFileSync(p, "utf8"),
  io,
  portState,
  noAnam: flags.noAnam,
  rebuild: flags.rebuild,
});
for (const c of pre.checks) {
  const mark = c.ok ? paint("32", "ok  ") : paint(C.err, "FAIL");
  log("pointy", `${mark} ${c.message}`);
  if (!c.ok && c.fix) log("pointy", `     fix: ${c.fix}`, C.err);
}
if (!pre.ok) {
  log("pointy", "preflight failed, fix the items above and rerun", C.err);
  process.exit(1);
}
if (flags.check) {
  log("pointy", "check only: nothing started");
  process.exit(0);
}

// Remediation: assets and stale builds.
if (pre.needsGestureAssets && !runSync("pointy", "npm", ["run", "gestures:assets"], root)) {
  log("pointy", "gesture asset setup failed", C.err);
  process.exit(1);
}
if (pre.needsBuild.desktop && !runSync("pointy", "npm", ["run", "build", "-w", "@pointy/desktop"], root)) {
  log("pointy", "desktop build failed", C.err);
  process.exit(1);
}
// The native AX helper is not covered by the desktop freshness check (its source lives in native/): the script is
// idempotent ("up to date" when the binary is newer than the source) and never fails, so run it on every launch.
runSync("ax-helper", "bash", [join(root, "scripts/build-ax-helper.sh")], root);
if (pre.needsBuild.anam && !runSync("anam", "npm", ["run", "build"], join(root, "anam-overlay"))) {
  log("anam", "build failed", C.err);
  process.exit(1);
}

// Process supervision.
const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("pointy", "stopping everything");
  for (const c of children) if (c.proc.exitCode === null) c.proc.kill("SIGTERM");
  const killer = setTimeout(() => {
    for (const c of children) if (c.proc.exitCode === null) c.proc.kill("SIGKILL");
    process.exit(code);
  }, 3000);
  const poll = setInterval(() => {
    if (children.every((c) => c.proc.exitCode !== null || c.proc.signalCode !== null)) {
      clearInterval(poll);
      clearTimeout(killer);
      process.exit(code);
    }
  }, 100);
}

function start(tag, color, cmd, args, opts) {
  const proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  const entry = { tag, proc };
  children.push(entry);
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) log(tag, l, color);
    });
    stream.on("end", () => buf && log(tag, buf, color));
  };
  pipe(proc.stdout);
  pipe(proc.stderr);
  proc.on("error", (e) => {
    log(tag, `failed to start: ${e.message}`, C.err);
    shutdown(1);
  });
  proc.on("exit", (code, sig) => {
    log(tag, `exited (${sig ?? code})`, color);
    shutdown(code ?? 0);
  });
  return entry;
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(0));

async function waitForHealth(timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !shuttingDown) {
    if ((await portState(BACKEND_PORT)) === "ours") return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

if (!flags.noAnam) {
  const anamDir = join(root, "anam-overlay");
  if (pre.backendRunning) {
    log("api", `reusing healthy backend on :${BACKEND_PORT}`, C.api);
  } else {
    start("api", C.api, join(anamDir, "backend/.venv/bin/python"), ["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)], {
      cwd: anamDir,
      env: process.env,
    });
    if (!(await waitForHealth())) {
      if (!shuttingDown) log("api", `backend did not become healthy on :${BACKEND_PORT}`, C.err);
      shutdown(1);
    } else {
      log("api", "backend healthy", C.api);
    }
  }
  if (!shuttingDown) start("anam", C.anam, "npm", ["start"], { cwd: anamDir, env: anamEnv(process.env) });
}

// The execution agent: what run_on_computer hands requests to. POINTY_EXECUTION=0 leaves it out.
const executionDir = join(root, "execution");
if (!shuttingDown && process.env.POINTY_EXECUTION !== "0") {
  if (existsSync(join(executionDir, "node_modules"))) {
    // Started directly, not through its launcher, so stopping the app also stops the service.
    start("exec", C.api, process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/serve.ts"], { cwd: executionDir, env: process.env });
  } else {
    log("exec", "execution/ has no node_modules: run `npm ci && npm run setup` there. Starting without the execution agent.", C.err);
  }
}

if (!shuttingDown) {
  start("pointy", C.pointy, "npx", ["electron", "."], {
    cwd: join(root, "apps/desktop"),
    env: pointyEnv(process.env, { debug: flags.debug }),
  });
  log("pointy", "running, Ctrl+C to stop (hotkey: Cmd+Option+P)");
}
