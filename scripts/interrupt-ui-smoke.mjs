import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { smokeSession } from './lib/smoke-session.mjs';

// Hold one live decision response so replacement is exercised while inference
// is pending. The proxy never executes native actions itself.
let release, reached;
const gate = new Promise(resolve => { release = resolve; });
const waiting = new Promise(resolve => { reached = resolve; });
let first = true;
const session = await smokeSession('jev', async (request, decision) => {
  const c = request.candidates.find(c => c.id === decision.candidateId);
  if (!c) return;
  assert.ok(['BROWSE_TREE','BROWSE_APPS','SEARCH_APPS','READ_SURFACE','READ_WINDOW','INSPECT_REGION','WAIT','FOCUS_WINDOW'].includes(c.operation) ||
    (c.operation === 'OPEN_APP' && ['Calculator','com.apple.calculator','TextEdit','com.apple.TextEdit'].includes(c.app)), 'Only application-opening actions in the interruption test');
  if (first) { first = false; reached(); await gate; }
});
async function until(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out waiting for UI state');
}
try {
  const page = session.page, input = page.getByLabel('What would you like to do?');
  await page.locator('.connection.connected').waitFor();
  const flags = await session.application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { size: window.getSize(), onTop: window.isAlwaysOnTop() };
  });
  assert.deepEqual(flags, { size: [380, 190], onTop: true });
  for (const width of [340, 380]) {
    await session.application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 190), width);
    await until(async () => await page.evaluate(() => innerWidth) === width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.assistant').scrollHeight <= innerHeight), true);
    await page.screenshot({ path: `.runtime/overlay-compact-${width}.png` });
  }
  await page.getByRole('button', { name: 'Show log' }).click();
  await until(async () => await page.evaluate(() => innerHeight) >= 400);
  assert.equal(await page.getByRole('heading', { name: 'Live log' }).isVisible(), true);
  await page.screenshot({ path: '.runtime/overlay-expanded-380.png' });
  await page.getByRole('button', { name: 'Hide log' }).click();
  await until(async () => await page.evaluate(() => innerHeight) === 190);
  await input.fill('Open Calculator.');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await until(async () => await input.inputValue() === '');
  const old = (await page.evaluate(() => window.desktop.state())).data;
  let timer;
  try { await Promise.race([waiting, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No pending live decision')), 20_000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(await input.isEnabled(), true);
  await input.fill('Open TextEdit.');
  await page.getByRole('button', { name: 'Send instruction' }).click();
  release();
  await until(async () => {
    const result = (await page.evaluate(() => window.desktop.state())).data;
    return result.taskId !== old.taskId && result.input.goal === 'Open TextEdit.';
  });
  await until(async () => await input.inputValue() === '');
  await until(async () => !(await page.evaluate(() => window.desktop.state())).data.busy, 40_000);
  const state = (await page.evaluate(() => window.desktop.state())).data;
  writeFileSync('.runtime/interrupt-ui-smoke.json', JSON.stringify({ oldTaskId: old.taskId, state, requests: session.requests }, null, 2));
  assert.equal(state.status, 'completed');
  assert.ok(['TextEdit', 'com.apple.TextEdit'].includes(state.observation.context.app));
  assert.equal(await input.isEnabled(), true);
  console.log('PASS: input clears, remains editable, replaces pending inference, and new TextEdit task completes.');
} finally { release(); await session.close(); }
