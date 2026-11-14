import { smokeSession } from './lib/smoke-session.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Live supervisor/Jev, real native accessibility. Playwright controls only our Electron UI.
const root = process.cwd();
const execute = promisify(execFile);
const native = path.join(root, '.runtime/native/agent-desktop');
const app = 'Microsoft Word';
const expectedText = 'hello how are you in it';
const variant = process.argv[2] || 'sol';
assert.ok(['none', 'luna', 'sol', 'cerebras'].includes(variant));
process.env.SUPERVISOR_PROVIDER = variant === 'cerebras' ? 'cerebras' : 'openai';
if (['luna', 'sol'].includes(variant)) {
  process.env.OPENAI_MODEL = variant === 'sol' ? 'gpt-6.1-sol' : 'gpt-6-luna';
  process.env.OPENAI_REASONING_EFFORT = variant === 'sol' ? 'low' : 'none';
  process.env.OPENAI_SERVICE_TIER = variant === 'sol' ? 'ultrafast' : '';
}
const goal = `Open Microsoft Word, create a new blank document, write "${expectedText}" and make that text large (24 pt).`;
const inventory = await execute(native, ['list-windows', '--app', app])
  .then(result => JSON.parse(result.stdout))
  .catch(error => {
    const result = JSON.parse(error.stdout || '{}');
    if (result.error?.code !== 'APP_NOT_FOUND') throw error;
    return { ok: true, data: [] };
  });
assert.equal(inventory.ok, true);
const originalWindows = new Set(inventory.data.map(w => w.id));
if (process.env.WORD_TEST_ANCHOR) {
  assert.ok(originalWindows.has(process.env.WORD_TEST_ANCHOR), 'The comparison starting window must still exist');
  // An explicit existing-window anchor avoids ambiguous app activation when
  // several documents are visible and none is currently focused.
  await execute(native, ['focus-window', '--app', app, '--window-id', process.env.WORD_TEST_ANCHOR]);
}
const reads = new Set(['BROWSE_TREE', 'BROWSE_APPS', 'READ_SURFACE', 'READ_WINDOW', 'INSPECT_REGION', 'SEARCH_APPS', 'WAIT']);
await execute('xcrun', ['swiftc', 'scripts/fixtures/read-text-style.swift', '-o', '.runtime/read-text-style']);
const session = await smokeSession('jev', (request, decision) => {
  const c = request.candidates.find(c => c.id === decision.candidateId);
  if (!c || reads.has(c.operation)) return;
  assert.notEqual(request.context.driver, 'browser');
  assert.ok([app, 'com.microsoft.Word'].includes(c.app) || (c.operation === 'OPEN_APP' && c.name === app),
    `Only Word may be mutated in this test: ${c.operation} in ${c.app}`);
  if (['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE'].includes(c.operation))
    assert.ok(!originalWindows.has(c.windowId), 'This smoke test writes only its newly created document');
  assert.ok(!/^(send|delete|discard|save|close)\b/i.test(c.name), 'Smoke test does not send, save, delete or close user work');
  if (c.operation === 'PRESS') assert.ok(['cmd+n', 'cmd+a', 'return', 'escape', 'tab', 'shift+tab', 'up', 'down', 'left', 'right', 'space'].includes(c.key));
});
let state;
const evidence = [];
const events = [];
let started, elapsedMs, styleEvidence, failure;
try {
  const page = session.page;
  await page.getByRole('heading', { name: 'Desktop Assistant' }).waitFor();
  const health = await page.evaluate(() => window.desktop.health());
  if (variant !== 'none') assert.equal(health.data.backend.supervisorConfigured, true);
  console.log('Supervisor model: ' + health.data.backend.supervisorModel);
  await page.getByLabel('What would you like to do?').fill(goal);
  started = performance.now();
  const accepted = await page.evaluate(({ goal, supervised }) => window.desktop.start({
    goal, mode: 'desktop', provider: 'jev', text: '', app: '', allowPhysical: false,
    maxSteps: 160, supervisorEvery: 12, supervisorEnabled: supervised, inputs: [],
  }, false), { goal, supervised: variant !== 'none' });
  assert.equal(accepted.ok, true);
  let lastEvent = 0;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    state = (await page.evaluate(() => window.desktop.state())).data;
    if (state.observation && evidence.at(-1)?.id !== state.observation.id) evidence.push(state.observation);
    for (const event of state.events.filter(e => e.id > lastEvent)) {
      events.push(event);
      if (['decision', 'result', 'error'].includes(event.type)) console.log(event.type + ': ' + event.message);
      lastEvent = event.id;
    }
    if (state.taskId && !state.busy) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  elapsedMs = performance.now() - started;
  assert.equal(state.status, 'completed', state.events.at(-1)?.message);
  assert.equal(events.some(e => e.message.startsWith('Supervisor:')), variant !== 'none');
  assert.ok(evidence.every(o => o.context.driver !== 'browser'));
  assert.ok(!originalWindows.has(state.observation.context.windowId), 'This smoke task must create its own new document');
  const { stdout } = await execute(native, ['snapshot', '--app', app, '--window-id', state.observation.context.windowId,
    '--compact', '--max-depth', '12'], { maxBuffer: 8 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  const flatten = n => n ? [n, ...(n.children || []).flatMap(flatten)] : [];
  const nodes = flatten(result.data.tree);
  const values = nodes.map(n => n.value).filter(v => typeof v === 'string');
  assert.ok(values.some(v => v.trim() === expectedText), 'Independent native read must show one copy of the exact body');
  assert.ok(nodes.some(n => /font size|size/i.test(n.name || n.description || '') && String(n.value).trim() === '24'),
    'Independent native read must expose 24 pt font size');
  styleEvidence = JSON.parse((await execute(path.join(root, '.runtime/read-text-style'),
    ['com.microsoft.Word', state.observation.snapshots[0].windowTitle, expectedText])).stdout);
  assert.equal(styleEvidence.complete, true);
  assert.equal(styleEvidence.matches.length, 1, 'Exactly one document body must match');
  assert.equal(styleEvidence.matches[0].unknownFont, false, 'Applied text style must be readable');
  assert.deepEqual(styleEvidence.matches[0].fontSizes, [24], 'Every non-whitespace text run must actually be 24 pt');
  console.log(`PASS: ${variant} → Jev → native Word, exact body once and applied 24 pt on every text run.`);
} catch (error) {
  failure = error.message;
  throw error;
} finally {
  elapsedMs ??= started ? performance.now() - started : undefined;
  if (state?.busy) await session.page.evaluate(() => window.desktop.cancel());
  const reviews = events.filter(e => e.message.startsWith('Supervisor:'));
  const metrics = { variant, success: !failure, failure, elapsedMs, decisions: state?.step,
    jevCalls: session.requests.filter(r => r.route === '/navigation/decide').length,
    textResolutionCalls: session.requests.filter(r => r.route === '/navigation/resolve-text').length,
    supervisorCalls: session.requests.filter(r => r.route === '/navigation/supervise').length,
    supervisorMs: reviews.reduce((n, e) => n + (e.details?.durationMs || 0), 0) };
  const result = { goal, metrics, state, evidence, events, styleEvidence, requests: session.requests };
  writeFileSync(path.join(root, `.runtime/word-comparison-${variant}.json`), JSON.stringify(result, null, 2));
  console.log('METRICS: ' + JSON.stringify(metrics));
  await session.close();
}
