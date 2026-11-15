// Pure preflight logic for scripts/pointy.mjs. All I/O is injected so it can be tested with mocks.
// Secrets: only key presence is ever checked, values are never returned or printed.
import { join } from "node:path";

export const BACKEND_PORT = 8765;
export const UV_COMMAND =
  "uv venv --clear --python 3.12 backend/.venv && uv pip install --python backend/.venv/bin/python -r backend/requirements.txt";

/** Finder duplicates such as "foo 2.ts", "foo 3.json" or "bar 2". */
export function isFinderDuplicate(name) {
  return /\s\d+(\.[^/]*)?$/.test(name);
}

/** Keys that are set to a non-empty value in dotenv text. */
export function parseEnvKeys(text) {
  const keys = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, "$2").trim();
    if (v !== "" && !v.startsWith("#")) keys.add(m[1]);
  }
  return keys;
}

export function nodeMajor(version) {
  const m = /^v?(\d+)\./.exec(version);
  return m ? Number(m[1]) : 0;
}

/**
 * Newest mtime (ms) under dir, skipping Finder duplicates, node_modules and dotfiles.
 * io: { readdir(dir) -> [{name,isDir}], mtime(path) -> number }
 */
export function newestMtime(dir, io) {
  let newest = 0;
  let entries;
  try {
    entries = io.readdir(dir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (isFinderDuplicate(e.name) || e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    const t = e.isDir ? newestMtime(p, io) : safeMtime(p, io);
    if (t > newest) newest = t;
  }
  return newest;
}

function safeMtime(p, io) {
  try {
    return io.mtime(p);
  } catch {
    return 0;
  }
}

/** A build is stale when its output is missing or older than the newest source. */
export function isStale({ srcDirs, outDir, io, extraSrcFiles = [] }) {
  const outNewest = newestMtime(outDir, io);
  if (outNewest === 0) return true;
  let src = 0;
  for (const d of srcDirs) src = Math.max(src, newestMtime(d, io));
  for (const f of extraSrcFiles) src = Math.max(src, safeMtime(f, io));
  return src > outNewest;
}

/**
 * Run all checks. deps: { root, env, nodeVersion, exists(path), readText(path), io, portState(port) }
 * portState resolves to "free" | "ours" | "busy".
 * Returns { checks: [{id, ok, message, fix?}], needsBuild: {desktop, anam}, needsGestureAssets, backendRunning }.
 */
export async function runPreflight(deps) {
  const { root, env, nodeVersion, exists, readText, io, portState, noAnam = false, rebuild = false } = deps;
  const checks = [];
  const add = (id, ok, message, fix) => checks.push({ id, ok, message, ...(fix ? { fix } : {}) });

  const major = nodeMajor(nodeVersion);
  add("node", major >= 22, `Node ${nodeVersion}`, "Install Node 22 or newer (e.g. `nvm install 22`).");

  const readKeys = (p) => {
    try {
      return exists(p) ? parseEnvKeys(readText(p)) : new Set();
    } catch {
      return new Set();
    }
  };
  const rootEnv = join(root, ".env");
  const anamEnv = join(root, "anam-overlay/backend/.env");
  const openai = env.OPENAI_API_KEY ? true : readKeys(rootEnv).has("OPENAI_API_KEY");
  add("openai-key", openai, openai ? "OPENAI_API_KEY present" : "OPENAI_API_KEY missing", `Add OPENAI_API_KEY=... to ${rootEnv}`);

  if (!noAnam) {
    const anam = readKeys(anamEnv).has("ANAM_API_KEY");
    add("anam-key", anam, anam ? "ANAM_API_KEY present" : "ANAM_API_KEY missing", `Add ANAM_API_KEY=... to ${anamEnv} (see .env.example there)`);

    const venvPy = join(root, "anam-overlay/backend/.venv/bin/python");
    const hasUvicorn = exists(join(root, "anam-overlay/backend/.venv/bin/uvicorn"));
    const hasVenv = exists(venvPy);
    add(
      "venv",
      hasVenv && hasUvicorn,
      hasVenv && hasUvicorn ? "backend venv has uvicorn" : "backend venv missing or has no uvicorn",
      `From anam-overlay/: ${UV_COMMAND}`,
    );
  }

  // Hotkey-only mode (POINTY_GESTURES=0) never loads the model, so it must start offline without it.
  const gesturesOn = env.POINTY_GESTURES !== "0";
  const gestureAssets =
    exists(join(root, "packages/gestures/.cache/public/models/gesture_recognizer.task")) &&
    exists(join(root, "packages/gestures/.cache/public/mediapipe-wasm"));
  if (gesturesOn) {
    add("gesture-assets", gestureAssets, gestureAssets ? "gesture assets present" : "gesture assets missing (will fetch)", "npm run gestures:assets");
  } else {
    add("gesture-assets", true, "gestures disabled (POINTY_GESTURES=0): assets not needed");
  }

  let backendRunning = false;
  if (!noAnam) {
    const state = await portState(BACKEND_PORT);
    backendRunning = state === "ours";
    add(
      "port",
      state !== "busy",
      state === "free" ? `port ${BACKEND_PORT} free` : state === "ours" ? `port ${BACKEND_PORT} already served by our backend (reusing)` : `port ${BACKEND_PORT} in use by another process`,
      `Free the port: lsof -nP -iTCP:${BACKEND_PORT} -sTCP:LISTEN, then kill that process.`,
    );
  }

  const desktopStale =
    rebuild ||
    isStale({
      srcDirs: [join(root, "apps/desktop/src"), join(root, "packages/shared/src"), join(root, "packages/gestures/src")],
      outDir: join(root, "apps/desktop/out"),
      extraSrcFiles: [join(root, "apps/desktop/electron.vite.config.ts")],
      io,
    });
  const anamStale =
    !noAnam &&
    (rebuild ||
      isStale({
        srcDirs: [join(root, "anam-overlay/src"), join(root, "anam-overlay/electron"), join(root, "anam-overlay/shared")],
        outDir: join(root, "anam-overlay/dist-electron"),
        extraSrcFiles: [join(root, "anam-overlay/vite.config.ts")],
        io,
      }) ||
      isStale({ srcDirs: [join(root, "anam-overlay/src")], outDir: join(root, "anam-overlay/dist"), io }));
  add("build-desktop", true, desktopStale ? "desktop build stale (will rebuild)" : "desktop build up to date");
  if (!noAnam) add("build-anam", true, anamStale ? "anam-overlay build stale (will rebuild)" : "anam-overlay build up to date");

  return {
    checks,
    ok: checks.every((c) => c.ok || c.id === "gesture-assets"),
    needsBuild: { desktop: desktopStale, anam: anamStale },
    needsGestureAssets: gesturesOn && !gestureAssets,
    backendRunning,
  };
}

/** Environment for the Pointy electron child. */
export function pointyEnv(base, { debug }) {
  const env = { ...base, POINTY_MODE: "production" };
  // Production defaults gestures on, but an explicit user value (e.g. 0) wins.
  if (env.POINTY_GESTURES === undefined || env.POINTY_GESTURES === "") env.POINTY_GESTURES = "1";
  if (env.POINTY_GESTURES_MOUSE === undefined || env.POINTY_GESTURES_MOUSE === "") env.POINTY_GESTURES_MOUSE = "1";
  delete env.ELECTRON_RUN_AS_NODE;
  if (debug) {
    env.POINTY_DEV_SERVER = "1";
    env.POINTY_GESTURES_SHOW = "1";
  }
  return env;
}

/** Environment for the Anam child: never leak browser-exposed or stray keys, speak-only mode on. */
/**
 * The model speaks in its own voice unless POINTY_VOICE=anam; the avatar then only lip-syncs to that audio.
 * Both the avatar window and its token broker read this.
 */
export function lipSyncEnv(base) {
  return base.POINTY_VOICE === "anam" ? {} : { ANAM_LIP_SYNC: "1" };
}

export function anamEnv(base) {
  const env = { ...base, ANAM_SPEAK_ONLY: "1", ...lipSyncEnv(base) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_ANAM_API_KEY;
  return env;
}

export function parseArgs(argv) {
  const flags = { help: false, check: false, noAnam: false, rebuild: false, debug: false, unknown: [] };
  for (const a of argv) {
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--check") flags.check = true;
    else if (a === "--no-anam") flags.noAnam = true;
    else if (a === "--rebuild") flags.rebuild = true;
    else if (a === "--debug") flags.debug = true;
    else flags.unknown.push(a);
  }
  return flags;
}
