import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startControlServer } = await import(pathToFileURL(path.join(root, 'dist-electron/control.mjs')).href);

const rect = { x: 1, y: 2, width: 320, height: 400 };
async function setup(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anam-control-'));
  const filePath = path.join(dir, 'sub', 'control.mjson');
  let state = { expanded: true, dragging: false, bounds: rect, workArea: { x: 0, y: 0, width: 1000, height: 800 }, displayId: '1', ...overrides };
  const moves = [];
  const server = await startControlServer({ port: 0, filePath, getState: () => state,
    moveTo: (x, y) => { moves.push([x, y]); return { ...rect, x, y }; } });
  const info = JSON.parse(await readFile(filePath, 'utf8'));
  const call = (route, { method = 'GET', headers = {}, body, token = info.token } = {}) =>
    fetch(`http://127.0.0.1:${server.port}${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(token ? { 'x-anam-control-token': token } : {}), ...headers } });
  return { server, info, filePath, dir, call, moves, set: (s) => { state = { ...state, ...s }; } };
}

test('control file is private, matches server, and is removed on close', async () => {
  const t = await setup();
  assert.equal(t.info.port, t.server.port);
  assert.equal(t.info.pid, process.pid);
  assert.equal((await stat(t.filePath)).mode & 0o777, 0o600);
  await t.server.close();
  await assert.rejects(stat(t.filePath));
  await rm(t.dir, { recursive: true });
});

test('close leaves a file owned by someone else', async () => {
  const t = await setup();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(t.filePath, JSON.stringify({ port: 1, token: 'other', pid: 1 }));
  await t.server.close();
  assert.equal(JSON.parse(await readFile(t.filePath, 'utf8')).token, 'other');
  await rm(t.dir, { recursive: true });
});

test('auth, host and origin checks', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('/state', { token: null })).status, 401);
    assert.equal((await t.call('/state', { token: 'wrong' })).status, 401);
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.server.port, path: '/state',
        headers: { origin: 'http://evil.example', 'x-anam-control-token': t.info.token } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    const ok = await t.call('/state');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal((await t.call('/nope')).status, 404);
  } finally { await t.server.close(); await rm(t.dir, { recursive: true }); }
});

test('bad Host header is rejected with 403', async () => {
  const t = await setup();
  try {
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.server.port, path: '/state',
        headers: { host: 'evil.example', 'x-anam-control-token': t.info.token } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
  } finally { await t.server.close(); await rm(t.dir, { recursive: true }); }
});

test('GET /state returns state, 503 without window', async () => {
  const t = await setup();
  try {
    const body = await (await t.call('/state')).json();
    assert.deepEqual(body, { ok: true, state: { expanded: true, dragging: false, bounds: rect,
      workArea: { x: 0, y: 0, width: 1000, height: 800 }, displayId: '1' } });
  } finally { await t.server.close(); await rm(t.dir, { recursive: true }); }
});

test('POST /move guards and success', async () => {
  const t = await setup({ expanded: false });
  try {
    let res = await t.call('/move', { method: 'POST', body: { x: 5, y: 6 } });
    assert.equal(res.status, 409); assert.equal((await res.json()).reason, 'collapsed');
    t.set({ expanded: true, dragging: true });
    res = await t.call('/move', { method: 'POST', body: { x: 5, y: 6 } });
    assert.equal(res.status, 409); assert.equal((await res.json()).reason, 'dragging');
    assert.equal(t.moves.length, 0);
    t.set({ dragging: false });
    res = await t.call('/move', { method: 'POST', body: { x: 5, y: 6 } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, bounds: { ...rect, x: 5, y: 6 } });
    for (const body of [{ x: 'a', y: 1 }, { x: 1 }, { x: 1e6, y: 0 }, { x: null, y: 0 }]) {
      res = await t.call('/move', { method: 'POST', body });
      assert.equal(res.status, 400); assert.equal((await res.json()).reason, 'invalid_input');
    }
    res = await fetch(`http://127.0.0.1:${t.server.port}/move`, { method: 'POST', body: 'not json',
      headers: { 'x-anam-control-token': t.info.token } });
    assert.equal(res.status, 400);
    res = await t.call('/move', { method: 'POST', body: { x: 1, y: 1, pad: 'a'.repeat(5000) } });
    assert.equal(res.status, 400);
  } finally { await t.server.close(); await rm(t.dir, { recursive: true }); }
});
