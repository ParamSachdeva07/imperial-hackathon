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

test('removeFileSync unlinks synchronously, only when owned', async () => {
  const { existsSync, writeFileSync } = await import('node:fs');
  const t = await setup();
  t.server.removeFileSync();
  assert.equal(existsSync(t.filePath), false);
  writeFileSync(t.filePath, JSON.stringify({ port: 1, token: 'other', pid: 1 }));
  t.server.removeFileSync();
  assert.equal(existsSync(t.filePath), true);
  await t.server.close();
  await rm(t.dir, { recursive: true });
});

test('stalled request bodies are timed out', async () => {
  const net = await import('node:net');
  const t = await setup();
  const sock = net.connect(t.server.port, '127.0.0.1');
  sock.write(`POST /move HTTP/1.1\r\nHost: 127.0.0.1:${t.server.port}\r\nx-anam-control-token: ${t.info.token}\r\nContent-Length: 50\r\n\r\n{`);
  sock.resume(); // drain the 408 so 'close' can fire
  const closed = new Promise((resolve) => { sock.on('close', resolve); sock.on('error', resolve); });
  const start = Date.now();
  await closed;
  assert.ok(Date.now() - start < 9000);
  await t.server.close();
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

// ---- speak-only routes (ANAM_SPEAK_ONLY=1): SDK-free, driven through a stub controller ----
const { createSpeakController } = await import(pathToFileURL(path.join(root, 'dist-electron/speak.mjs')).href);

async function setupSpeak(depOverrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anam-control-'));
  const filePath = path.join(dir, 'control.json');
  const sent = []; const expands = []; const timers = [];
  let clock = 1000;
  const speak = createSpeakController({ send: (c) => sent.push(c), setExpanded: (v) => expands.push(v), now: () => clock,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: (h) => { h.cleared = true; }, ...depOverrides });
  const server = await startControlServer({ port: 0, filePath, speak,
    getState: () => ({ expanded: true, dragging: false, bounds: rect, workArea: { x: 0, y: 0, width: 1000, height: 800 }, displayId: '1' }),
    moveTo: () => rect });
  const info = JSON.parse(await readFile(filePath, 'utf8'));
  const call = (route, body, method = 'POST') => fetch(`http://127.0.0.1:${server.port}${route}`, { method,
    body: body === undefined ? undefined : JSON.stringify(body), headers: { 'x-anam-control-token': info.token } });
  return { server, speak, sent, expands, timers, call, dir, tick: (ms) => { clock += ms; } };
}
const done = async (t) => { await t.server.close(); await rm(t.dir, { recursive: true }); };

test('without speak mode the speak routes are 404 and /state is unchanged', async () => {
  const t = await setup();
  try {
    for (const r of ['/session', '/talk', '/interrupt']) {
      assert.equal((await t.call(r, { method: 'POST', body: { action: 'start' } })).status, 404);
    }
    assert.equal('connected' in (await (await t.call('/state')).json()).state, false);
  } finally { await t.server.close(); await rm(t.dir, { recursive: true }); }
});

test('speak: validation, auth, 503 without a call', async () => {
  const t = await setupSpeak();
  try {
    const noAuth = await fetch(`http://127.0.0.1:${t.server.port}/talk`, { method: 'POST', body: '{}' });
    assert.equal(noAuth.status, 401);
    assert.equal((await t.call('/talk', { turnId: 'a', text: 'hi', final: true })).status, 503);
    for (const body of [{}, { turnId: '', text: 'x', final: true }, { turnId: 'a'.repeat(65), text: 'x', final: true },
      { turnId: 'a', text: 'x'.repeat(2001), final: true }, { turnId: 'a', text: 'x' }, { turnId: 'a', text: '', final: false },
      { turnId: 1, text: 'x', final: true }]) {
      await t.call('/session', { action: 'start' });
      assert.equal((await t.call('/talk', body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal((await t.call('/session', { action: 'pause' })).status, 400);
    assert.equal((await t.call('/session', {})).status, 400);
  } finally { await done(t); }
});

test('speak: start expands and asks the renderer; talk queues until connected then flushes in order', async () => {
  const t = await setupSpeak();
  try {
    assert.equal((await t.call('/session', { action: 'start' })).status, 200);
    assert.deepEqual(t.expands, [true]);
    assert.deepEqual(t.sent, [{ type: 'start', session: 1 }]);
    let res = await t.call('/talk', { turnId: 'a', text: 'one ', final: false });
    assert.deepEqual(await res.json(), { ok: true, queued: true });
    await t.call('/talk', { turnId: 'a', text: 'two', final: true });
    assert.equal(t.sent.length, 1);
    let state = (await (await t.call('/state', undefined, 'GET')).json()).state;
    assert.equal(state.connected, false); assert.equal(state.starting, true);
    t.speak.report({ connected: true });
    assert.deepEqual(t.sent.slice(1), [{ type: 'talk', turnId: 'a', text: 'one ', final: false },
      { type: 'talk', turnId: 'a', text: 'two', final: true }]);
    res = await t.call('/talk', { turnId: 'b', text: 'live', final: true });
    assert.deepEqual(await res.json(), { ok: true, queued: false });
    t.speak.report({ speaking: true });
    state = (await (await t.call('/state', undefined, 'GET')).json()).state;
    assert.equal(state.connected, true); assert.equal(state.speaking, true); assert.equal(state.expanded, true);
    assert.equal((await t.call('/interrupt', {})).status, 200);
    assert.deepEqual(t.sent.at(-1), { type: 'interrupt' });
  } finally { await done(t); }
});

test('speak: queue is bounded (20) and stale chunks (30s) are dropped', async () => {
  const t = await setupSpeak();
  try {
    await t.call('/session', { action: 'start' });
    for (let i = 0; i < 20; i++) assert.equal((await t.call('/talk', { turnId: 'a', text: 'c', final: false })).status, 200);
    assert.equal((await t.call('/talk', { turnId: 'a', text: 'c', final: false })).status, 429);
    t.tick(31_000);
    assert.equal((await t.call('/talk', { turnId: 'b', text: 'fresh', final: true })).status, 200);
    t.speak.report({ connected: true });
    assert.deepEqual(t.sent.slice(1), [{ type: 'talk', turnId: 'b', text: 'fresh', final: true }]);
  } finally { await done(t); }
});

test('speak: end collapses and clears; user End call is visible in /state; idle safety stop', async () => {
  const t = await setupSpeak();
  try {
    await t.call('/session', { action: 'start' });
    t.speak.report({ connected: true });
    // user hung up in the UI
    t.speak.report({ connected: false });
    assert.equal(t.expands.at(-1), false);
    assert.equal((await (await t.call('/state', undefined, 'GET')).json()).state.connected, false);
    assert.equal((await t.call('/talk', { turnId: 'a', text: 'x', final: true })).status, 503);
    // explicit end
    await t.call('/session', { action: 'start' });
    t.speak.report({ connected: true });
    t.sent.length = 0;
    assert.equal((await t.call('/session', { action: 'end' })).status, 200);
    assert.deepEqual(t.sent, [{ type: 'end' }]);
    assert.equal(t.expands.at(-1), false);
    // idle timer is 3 minutes and fires an end
    await t.call('/session', { action: 'start' });
    t.speak.report({ connected: true });
    const idle = t.timers.filter((h) => !h.cleared).at(-1);
    assert.equal(idle.ms, 180_000);
    t.sent.length = 0;
    idle.fn();
    assert.deepEqual(t.sent, [{ type: 'end' }]);
    assert.equal(t.expands.at(-1), false);
  } finally { await done(t); }
});

test('speak: a teardown report from an earlier call cannot cancel a newer call', async () => {
  const t = await setupSpeak();
  try {
    await t.call('/session', { action: 'start' }); // session 1
    t.speak.report({ connected: true, session: 1 });
    await t.call('/session', { action: 'end' });
    await t.call('/session', { action: 'start' }); // session 2 reaches main before call 1's teardown report
    assert.deepEqual(t.sent.at(-1), { type: 'start', session: 2 });
    await t.call('/talk', { turnId: 'a', text: 'hello', final: true });
    t.speak.report({ connected: false, session: 1 }); // stale
    t.speak.report({ speaking: true, session: 1 }); // stale
    let state = (await (await t.call('/state', undefined, 'GET')).json()).state;
    assert.equal(state.starting, true); assert.equal(state.speaking, false);
    assert.equal((await t.call('/talk', { turnId: 'a', text: 'more', final: true })).status, 200); // still queued, not no_call
    t.sent.length = 0;
    t.speak.report({ connected: true, session: 2 });
    assert.equal(t.sent.length, 2); // queued speech flushed
    t.speak.report({ connected: false, session: 2 }); // the current call ending still works
    state = (await (await t.call('/state', undefined, 'GET')).json()).state;
    assert.equal(state.connected, false); assert.equal(state.starting, false);
  } finally { await done(t); }
});
