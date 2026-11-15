import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureNative } from './build-native.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime');
const apiRoot = path.join(root, 'services/decision-api');
const mode = process.argv[2] || 'serve';
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
  if (mode === 'setup') {
    if (!existsSync(path.join(apiRoot, '.env'))) {
      copyFileSync(path.join(apiRoot, '.env.example'), path.join(apiRoot, '.env'));
      chmodSync(path.join(apiRoot, '.env'), 0o600);
    }
    await run(uv, ['sync', '--group', 'dev'], { cwd: apiRoot });
    await ensureNative(root);
    console.log('Setup complete. Run npm run serve.');
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
  if (mode === 'serve') {
    // Headless: no window. Another program on this machine starts and watches tasks.
    await ensureNative(root);
    await node('node_modules/tsx/dist/cli.mjs', ['scripts/serve.ts']);
    return;
  }
  throw new Error('Unknown command: ' + mode);
}
