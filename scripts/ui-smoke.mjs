import { smokeSession } from './lib/smoke-session.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const mode = process.env.ASSISTANT_TEST_PROVIDER === 'jev' ? 'jev' : 'local';
const session = await smokeSession(mode);
const { application, page } = session;
try {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.getByRole('heading', { name: 'Desktop Assistant' }).waitFor();
  await page.waitForFunction(
    async () => {
      const result = await window.desktop.health();
      return result.ok && result.data.native.accessibility === 'granted';
    },
    null,
    { timeout: 10_000 },
  );
  await page.evaluate(
    (provider) =>
      window.desktop.start(
        {
          goal: 'Create a fresh TextEdit document containing Hello Alex',
          text: 'Hello Alex',
          mode: 'textedit',
          provider,
        },
        false,
      ),
    mode,
  );
  let state;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.desktop.state());
    assert.equal(result.ok, true);
    state = result.data;
    if (state.taskId && !state.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(
    JSON.stringify(
      {
        provider: mode,
        status: state?.status,
        model: state?.decision?.model,
        confidence: state?.decision?.confidence,
        steps: state?.step,
        events: state?.events.map((e) => e.message),
      },
      null,
      2,
    ),
  );
  assert.equal(state?.status, 'completed', 'UI task must complete with verified text.');
  assert.equal(state?.verifiedText, 'Hello Alex');
  assert.equal(state?.decision?.provider, mode);
  assert.deepEqual(browserErrors, []);
  const screenshot = path.join(root, '.runtime', 'navigation-lab-' + mode + '.png');
  await page.screenshot({ path: screenshot });
  const report = {
    testedAt: new Date().toISOString(),
    provider: mode,
    model: state.decision.model,
    confidence: state.decision.confidence,
    status: state.status,
    verifiedText: state.verifiedText,
    steps: state.step,
    windowId: state.document.windowId,
    screenshot,
    browserErrors,
  };
  writeFileSync(path.join(root, '.runtime', 'ui-smoke-' + mode + '.json'), JSON.stringify(report, null, 2));
  for (const [width, height] of [
    [1080, 820],
    [640, 600],
  ]) {
    await application.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'Layout must not overflow horizontally',
    );
    assert.equal(await page.getByRole('textbox', { name: 'What would you like to do?' }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'Live log' }).isVisible(), true);
    await page.screenshot({ path: path.join(root, '.runtime', `ui-${width}x${height}.png`) });
  }
  console.log('PASS: Electron UI → controller → ' + mode + ' → native TextEdit → observed text.');
} finally {
  await session.close();
}
