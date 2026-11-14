import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ANAM_API_KEY;
delete env.VITE_ANAM_API_KEY;
delete env.OVERLAY_DEV;

async function launch(dev = false) {
  const application = await electron.launch({ args: [path.join(root, 'dist-electron/main.mjs')],
    cwd: root, env: { ...env, ...(dev ? { OVERLAY_DEV: '1' } : {}) }, timeout: 20_000 });
  const page = await application.firstWindow();
  await page.locator('.launcher').waitFor({ state: 'attached' });
  await application.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    globalThis.__testPointer = { x: area.x + 200, y: area.y + 200 };
    screen.getCursorScreenPoint = () => globalThis.__testPointer;
    const win = BrowserWindow.getAllWindows()[0];
    const original = win.setIgnoreMouseEvents.bind(win);
    win.setIgnoreMouseEvents = (ignore, options) => {
      globalThis.__testIgnoringMouse = ignore; original(ignore, options);
    };
  });
  await revealDot(application, page);
  return { application, page };
}

async function revealDot(application, page) {
  await application.evaluate(({ BrowserWindow, screen }) => {
    const display = screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds());
    globalThis.__testPointer = { x: display.bounds.x + display.bounds.width - 1, y: display.bounds.y + 1 };
  });
  await page.waitForFunction(() => document.querySelector('.launcher').classList.contains('is-revealed'));
}

async function leaveCorner(application, page) {
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.overlay.setLauncherFocused(false);
  });
  await application.evaluate(({ screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    globalThis.__testPointer = { x: area.x + 200, y: area.y + 200 };
  });
}

test('hidden corner launcher reveals on hover, passes through clicks, and docks after closing', { timeout: 40_000 }, async () => {
  await mkdir(results, { recursive: true });
  const { application, page } = await launch();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const state = await application.evaluate(async ({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const preferences = win.webContents.getLastWebPreferences();
      const capture = await win.webContents.capturePage();
      return { top: win.isAlwaysOnTop(), cornerAlpha: capture.toBitmap()[3], bounds: win.getBounds(),
        area: screen.getPrimaryDisplay().workArea, isolated: preferences.contextIsolation,
        sandbox: preferences.sandbox, node: preferences.nodeIntegration };
    });
    assert.equal(state.top, true);
    assert.equal(state.cornerAlpha, 0);
    assert.equal(state.isolated, true);
    assert.equal(state.sandbox, true);
    assert.equal(state.node, false);
    assert.equal(state.bounds.width, 56);
    assert.equal(state.bounds.height, 56);
    assert.equal(state.bounds.x + state.bounds.width, state.area.x + state.area.width - 16);
    assert.equal(state.bounds.y, state.area.y + 16);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.getByRole('button').count(), 1);
    await leaveCorner(application, page);
    await page.waitForFunction(() => !document.querySelector('.launcher').classList.contains('is-revealed'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.launcher')).opacity === '0');
    assert.equal(await application.evaluate(() => globalThis.__testIgnoringMouse), true);
    await page.screenshot({ path: path.join(results, 'overlay-hidden.png'), omitBackground: true });
    await revealDot(application, page);
    assert.equal(await application.evaluate(() => globalThis.__testIgnoringMouse), false);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.launcher')).opacity === '1');
    await page.screenshot({ path: path.join(results, 'overlay-dot.png'), omitBackground: true });
    // A keyboard user can also reveal the launcher without hovering.
    await leaveCorner(application, page);
    await page.waitForFunction(() => !document.querySelector('.launcher').classList.contains('is-revealed'));
    await page.locator('.launcher').focus();
    await page.waitForFunction(() => document.querySelector('.launcher').classList.contains('is-revealed'));
    await revealDot(application, page);
    const moved = state.bounds;
    await page.evaluate(() => window.overlay.setExpanded('invalid'));
    assert.equal(await page.evaluate(() => window.innerWidth), 56);

    // Exercise the real IPC/token request, without contacting Anam or requesting a microphone.
    await application.evaluate(() => {
      globalThis.fetch = async () => { throw new Error('test network unavailable'); };
    });
    await page.getByRole('button', { name: 'Open Anam and start a call' }).click();
    await page.getByRole('alert').filter({ hasText: 'Cannot reach the local backend' }).waitFor();
    await page.waitForFunction(() => window.innerWidth === 320 && window.innerHeight === 400);
    const expandedBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.equal(expandedBounds.x + expandedBounds.width, moved.x + moved.width);
    assert.equal(expandedBounds.y, moved.y);
    await page.screenshot({ path: path.join(results, 'overlay-error.png'), omitBackground: true });

    await page.evaluate(() => window.overlay.resizeBy(-80));
    await page.waitForFunction(() => window.innerWidth === 240 && window.innerHeight === 320);
    await page.screenshot({ path: path.join(results, 'overlay-small-circle.png'), omitBackground: true });
    const layout = await page.evaluate(() => {
      const circle = document.querySelector('.avatar').getBoundingClientRect();
      const controls = document.querySelector('.call-controls').getBoundingClientRect();
      return { width: circle.width, height: circle.height, controlsBottom: controls.bottom };
    });
    assert.equal(layout.width, layout.height);
    assert.ok(layout.controlsBottom <= 320);
    await page.evaluate(() => window.overlay.resizeBy(Number.NaN));
    assert.equal(await page.evaluate(() => window.innerWidth), 240);
    await leaveCorner(application, page);
    await page.getByRole('button', { name: 'End call and return to dot' }).click();
    await page.waitForFunction(() => window.innerWidth === 56 && window.innerHeight === 56);
    await page.waitForFunction(() => !document.querySelector('.launcher').classList.contains('is-revealed'));
    assert.equal(await application.evaluate(() => globalThis.__testIgnoringMouse), true);
    const collapsedBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.deepEqual(collapsedBounds, moved);
    assert.deepEqual(errors, []);
  } finally { await application.close(); }
});

test('dot-to-call lifecycle, mute, hangup, reconnect and cancellation', { timeout: 60_000 }, async (t) => {
  const server = await createServer({ configFile: false, root, plugins: [react()],
    resolve: { alias: [{ find: '@anam-ai/js-sdk', replacement: path.join(root, 'tests/fake-sdk.mjs') }] },
    server: { host: '127.0.0.1', port: 5173, strictPort: true } });
  let application;
  try {
    await server.listen();
    const launched = await launch(true);
    application = launched.application;
    const page = launched.page;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('overlay:microphone');
      ipcMain.handle('overlay:microphone', () => true);
      globalThis.fetch = async (url, options) => {
        if (url !== 'http://127.0.0.1:8765/api/session-token' || options.method !== 'POST'
          || options.headers['X-Anam-Overlay'] !== '1') throw new Error('Incorrect backend request');
        return new Response(JSON.stringify({ sessionToken: 'test-ephemeral-token' }), { status: 200 });
      };
    });
    const dot = () => page.getByRole('button', { name: 'Open Anam and start a call' });
    const end = () => page.getByRole('button', { name: 'End call and return to dot' });
    const connected = () => page.waitForFunction(() => !document.querySelector('.mute-button').disabled);
    const collapsed = () => page.waitForFunction(() => window.innerWidth === 56 && !document.querySelector('.launcher').hidden);

    await t.test('one click starts voice with exactly two controls; hangup stops audio and returns to dot', async () => {
      await dot().click();
      await connected();
      assert.equal(await page.evaluate(() => window.__anamFixture.clients.length), 1);
      assert.equal(await page.evaluate(() => window.__anamFixture.clients[0].options.disableInputAudio), false);
      assert.equal(await page.getByRole('button').count(), 2);
      const circle = await page.locator('.avatar').boundingBox();
      assert.ok(Math.abs(circle.width - circle.height) < 0.1);
      assert.equal(await page.locator('.avatar').evaluate((element) => getComputedStyle(element).borderRadius), '50%');
      assert.equal(await page.locator('.avatar').evaluate((element) => getComputedStyle(element).borderColor), 'rgb(0, 136, 255)');
      await page.mouse.move(4, 4);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.mute-button')).backgroundColor === 'rgb(52, 199, 89)');
      assert.equal(await page.locator('.end-button').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 56, 60)');
      await leaveCorner(application, page);
      assert.equal(await page.evaluate(() => window.innerWidth), 320);
      assert.equal(await application.evaluate(() => globalThis.__testIgnoringMouse), false);
      await application.evaluate(({ screen }) => {
        const bounds = screen.getPrimaryDisplay().bounds;
        globalThis.__testPointer = { x: bounds.x + bounds.width - 1, y: bounds.y + 1 };
      });
      await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Unmute microphone' }).getAttribute('aria-pressed'), 'true');
      await page.mouse.move(4, 4);
      await page.screenshot({ path: path.join(results, 'overlay-circle-muted.png'), omitBackground: true, animations: 'disabled' });
      await page.getByRole('button', { name: 'Unmute microphone' }).click();
      await page.mouse.move(4, 4);
      await page.screenshot({ path: path.join(results, 'overlay-circle.png'), omitBackground: true, animations: 'disabled' });
      await end().click();
      await collapsed();
      const cleanup = await page.evaluate(() => ({ stops: window.__anamFixture.clients[0].stopCount,
        listeners: window.__anamFixture.clients[0].listenerCount(), tracks: window.__anamFixture.trackStops }));
      assert.equal(cleanup.stops, 1);
      assert.equal(cleanup.listeners, 0);
      assert.equal(cleanup.tracks, 1);
      assert.equal(await page.getByRole('button').count(), 1);
    });

    await t.test('reopens after hangup and Escape returns to the same dot', async () => {
      await dot().press('Enter');
      await connected();
      assert.equal(await page.evaluate(() => window.__anamFixture.clients.length), 2);
      await page.keyboard.press('Escape');
      await collapsed();
    });

    await t.test('a dropped session offers retry inside the circle', async () => {
      await dot().click();
      await connected();
      await page.evaluate(() => window.__anamFixture.clients.at(-1).disconnect());
      await page.getByRole('alert').filter({ hasText: 'disconnected' }).waitFor();
      await page.getByRole('button', { name: 'Try again' }).click();
      await connected();
      await end().click();
      await collapsed();
    });

    await t.test('cancel during connection stops late media without reopening the circle', async () => {
      await page.evaluate(() => { window.__anamFixture.delay = 600; });
      await dot().click();
      await page.getByRole('status').filter({ hasText: 'Connecting to your persona' }).waitFor();
      await end().click();
      await collapsed();
      await page.waitForFunction(() => window.__anamFixture.clients.at(-1).stopCount >= 2);
      assert.equal(await page.evaluate(() => window.__anamFixture.clients.at(-1).listenerCount()), 0);
      assert.equal(await end().count(), 0);
    });

    await t.test('SDK failures are safe and the user can collapse without a connection', async () => {
      await page.evaluate(() => { window.__anamFixture.delay = 1; window.__anamFixture.fail = true; });
      await dot().click();
      await page.getByRole('button', { name: 'Try again' }).waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), /secret-upstream-debug-details/);
      await end().click();
      await collapsed();
      await page.evaluate(() => { window.__anamFixture.fail = false; });
    });

    await t.test('microphone denial does not start a session and still returns to dot', async () => {
      await application.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('overlay:microphone');
        ipcMain.handle('overlay:microphone', () => false);
      });
      const count = await page.evaluate(() => window.__anamFixture.clients.length);
      await dot().click();
      await page.getByRole('alert').filter({ hasText: 'Microphone access is off' }).waitFor();
      assert.equal(await page.evaluate(() => window.__anamFixture.clients.length), count);
      await end().click();
      await collapsed();
    });
    assert.deepEqual(errors, []);
  } finally { if (application) await application.close(); await server.close(); }
});

test('renderer build contains no backend configuration', async () => {
  const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
  const scriptPath = html.match(/src="(.+?\.js)"/)[1];
  const script = await readFile(path.resolve(root, 'dist', scriptPath), 'utf8');
  assert.doesNotMatch(script, /ANAM_API_KEY|ec3b8e17-2ff7-517d-92e5-c13a3a865023/);
});
