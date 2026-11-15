import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { ensureNative } from './build-native.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime');
const apiRoot = path.join(root, 'services/decision-api');
const mode = process.argv[2] || 'dev';
const major = Number(process.versions.node.split('.')[0]);
const configuredNode =
  process.env.ASSISTANT_NODE ||
  (existsSync(path.join(runtime, 'node-path'))
    ? readFileSync(path.join(runtime, 'node-path'), 'utf8').trim()
    : null);
if (major < 22 || (major === 22 && Number(process.versions.node.split('.')[1]) < 12)) {
  if (!configuredNode || configuredNode === process.execPath || !existsSync(configuredNode)) {
    console.error('Node 22.12+ is required. Install Node 24 or set ASSISTANT_NODE to its executable.');
    process.exit(1);
  }
  const child = spawn(configuredNode, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  await main();
}
async function main() {
  mkdirSync(runtime, { recursive: true });
  const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  const children = [];
  const run = (command, args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', ...options });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(command + ' exited ' + code))));
    });
  const uv =
    process.env.UV_BINARY ||
    (existsSync(path.join(process.env.HOME || '', '.local/bin/uv'))
      ? path.join(process.env.HOME, '.local/bin/uv')
      : 'uv');
  const python = (args) => run(uv, ['run', ...args], { cwd: apiRoot });
  const node = (script, args = []) => run(process.execPath, [script, ...args]);
  async function buildMain() {
    const { build } = await import('esbuild');
    const common = {
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      sourcemap: true,
    };
    await build({
      ...common,
      entryPoints: ['apps/desktop/electron/main.ts'],
      outfile: 'apps/desktop/dist-electron/main.cjs',
      absWorkingDir: root,
    });
    await build({
      ...common,
      entryPoints: ['apps/desktop/electron/preload.ts'],
      outfile: 'apps/desktop/dist-electron/preload.cjs',
      absWorkingDir: root,
    });
  }
  async function ensureElectron() {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    try {
      return require('electron');
    } catch {
      await node('node_modules/electron/install.js');
      return require('electron');
    }
  }
  if (mode === 'setup') {
    if (!existsSync(path.join(apiRoot, '.env'))) {
      copyFileSync(path.join(apiRoot, '.env.example'), path.join(apiRoot, '.env'));
      chmodSync(path.join(apiRoot, '.env'), 0o600);
    }
    await run(uv, ['sync', '--group', 'dev'], { cwd: apiRoot });
    await ensureElectron();
    await ensureNative(root);
    console.log('Setup complete. Run npm run dev.');
    return;
  }
  if (mode === 'test') {
    await node('node_modules/typescript/bin/tsc', ['--noEmit']);
    await node('node_modules/vitest/vitest.mjs', ['run']);
    await node('scripts/test-paste.mjs');
    await python(['pytest', '-q']);
    return;
  }
  if (mode === 'extension') {
    // Runs the browser extension in Playwright's own Chromium against a local fixture page.
    await node('node_modules/tsx/dist/cli.mjs', ['scripts/page-bridge-e2e.ts']);
    return;
  }
  if (mode === 'eval' || mode === 'replay') {
    // Live evaluation drives real applications; see scripts/eval/README.md before running it.
    if (mode === 'eval') await ensureNative(root);
    await node('node_modules/tsx/dist/cli.mjs', ['scripts/eval/' + (mode === 'eval' ? 'run.ts' : 'replay.ts'), ...process.argv.slice(3)]);
    return;
  }
  if (mode === 'native') {
    await ensureNative(root);
    await node('node_modules/tsx/dist/cli.mjs', ['scripts/native-smoke.ts']);
    return;
  }
  if (mode === 'build' || mode === 'package') {
    const nativeDir = await ensureNative(root);
    await node('node_modules/typescript/bin/tsc', ['--noEmit']);
    await node('node_modules/vite/bin/vite.js', ['build']);
    await buildMain();
    if (mode === 'package') {
      const { packager } = await import('@electron/packager');
      const apps = await packager({
        dir: root,
        out: path.join(root, 'release'),
        name: 'Desktop Assistant Lab',
        appBundleId: 'local.desktopassistant.lab',
        platform: 'darwin',
        arch: process.arch,
        overwrite: true,
        asar: true,
        prune: true,
        extraResource: [nativeDir],
        ignore: [
          /^\/\.runtime/,
          /^\/release/,
          /^\/services/,
          /^\/tests/,
          /^\/docs/,
          /^\/scripts/,
          /^\/node_modules\/agent-desktop/,
          /^\/node_modules\/agent-browser/,
        ],
        extendInfo: {
          NSAppleEventsUsageDescription:
            'Create and inspect TextEdit test documents for accessibility navigation.',
        },
      });
      console.log(apps.join('\n'));
    }
    return;
  }
  if (mode !== 'dev') throw new Error('Unknown command: ' + mode);
  await ensureNative(root);
  await buildMain();
  const electron = await ensureElectron();
  const port = () =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const value = server.address().port;
        server.close(() => resolve(value));
      });
    });
  const apiPort = await port(),
    uiPort = await port();
  const token = randomBytes(32).toString('hex');
  const apiUrl = 'http://127.0.0.1:' + apiPort,
    uiUrl = 'http://127.0.0.1:' + uiPort;
  const clean = (code = 0) => {
    for (const child of children) child.kill('SIGTERM');
    process.exit(code);
  };
  process.on('SIGINT', () => clean());
  process.on('SIGTERM', () => clean());
  const background = (command, args, options = {}) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', ...options });
    children.push(child);
    child.on('error', (error) => {
      console.error(error.message);
      clean(1);
    });
    return child;
  };
  const apiChild = background(
    uv,
    ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort), '--no-access-log'],
    {
      cwd: apiRoot,
      env: { ...env, DECISION_API_TOKEN: token },
    },
  );
  const uiChild = background(process.execPath, [
    'node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(uiPort),
    '--strictPort',
  ]);
  const waitReady = async (url, child, headers = {}) => {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error('A development service stopped before becoming ready.');
      try {
        if ((await fetch(url, { headers, signal: AbortSignal.timeout(1000) })).ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Timed out starting ' + url);
  };
  try {
    await Promise.all([
      waitReady(apiUrl + '/health', apiChild, { Authorization: 'Bearer ' + token }),
      waitReady(uiUrl, uiChild),
    ]);
    const electronEnv = {
      ...env,
      ASSISTANT_ROOT: root,
      ASSISTANT_RENDERER_URL: uiUrl,
      DECISION_API_URL: apiUrl,
      DECISION_API_TOKEN: token,
    };
    delete electronEnv.TYPESAFE_API_KEY;
    delete electronEnv.OPENAI_API_KEY;
    delete electronEnv.CEREBRAS_API_KEY;
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    const desktop = background(electron, ['.'], { env: electronEnv });
    writeFileSync(
      path.join(runtime, 'session.json'),
      JSON.stringify({ uiUrl, apiUrl, pid: desktop.pid }, null, 2),
    );
    desktop.on('exit', (code) => clean(code ?? 0));
    console.log('Navigation lab is running. Closing the window stops its local services.');
  } catch (error) {
    console.error(error.message);
    clean(1);
  }
}
