import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { smokeSession } from './lib/smoke-session.mjs';

const execute = promisify(execFile);
const native = process.cwd() + '/.runtime/native/agent-desktop';
const read = async args => {
  const result = JSON.parse((await execute(native, args, { maxBuffer: 8 * 1024 * 1024 })).stdout);
  assert.equal(result.ok, true);
  return result.data;
};
const windows = await read(['list-windows', '--app', 'Google Chrome']);
const window = windows.find(w => w.is_focused) || windows[0];
assert.ok(window);
await read(['launch', 'com.google.Chrome', '--activate']);
await read(['focus-window', '--app', 'Google Chrome', '--window-id', window.id]);
const snapshot = () => read(['snapshot', '--app', 'Google Chrome', '--window-id', window.id, '--compact', '--max-depth', '6']);
const flatten = n => n ? [n, ...(n.children || []).flatMap(flatten)] : [];
// Test oracle only: regular Chrome exposes its tab-strip items as radio buttons.
const tabs = s => flatten(s.tree).filter(n => n.role === 'radiobutton');
const before = await snapshot();
assert.equal(before.complete, true);
let state, elapsedMs, failure, attemptedCreations = 0;
const events = [];
const session = await smokeSession('jev', (request, decision) => {
  const c = request.candidates.find(c => c.id === decision.candidateId);
  // The controller intercepts a positive completion Noul before dispatch.
  if (decision.goalCompletionProbability > .5 && request.tree.view === 'tree') return;
  if (!c || ['BROWSE_TREE', 'BROWSE_APPS', 'READ_WINDOW', 'READ_SURFACE', 'INSPECT_REGION', 'SEARCH_APPS', 'WAIT'].includes(c.operation)) return;
  assert.ok(['Google Chrome', 'com.google.Chrome'].includes(c.app), 'Only Chrome may be controlled');
  if (['OPEN_APP', 'FOCUS_WINDOW', 'FOCUS'].includes(c.operation)) return;
  assert.ok((c.operation === 'PRESS' && c.key === 'cmd+t') || (c.operation === 'CLICK' && c.name === 'New Tab'),
    'This smoke test may only create a tab');
  assert.ok(++attemptedCreations <= 1, 'Duplicate creation proposal: fail without adding another tab');
});
let after;
try {
  await session.page.getByRole('heading', { name: 'Desktop Assistant' }).waitFor();
  const started = performance.now();
  const result = await session.page.evaluate(() => window.desktop.start({
    goal: 'can you open a new chrome tab', provider: 'jev', mode: 'desktop',
    supervisorEnabled: true, supervisorEvery: 12, maxSteps: 160,
  }, false));
  assert.equal(result.ok, true);
  let last = 0;
  while (performance.now() - started < 120_000) {
    state = (await session.page.evaluate(() => window.desktop.state())).data;
    for (const event of state.events.filter(e => e.id > last)) {
      events.push(event); last = event.id;
      if (['decision', 'result', 'error'].includes(event.type)) console.log(event.type + ': ' + event.message);
    }
    if (state.taskId && !state.busy) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  elapsedMs = performance.now() - started;
  if (state.busy) await session.page.evaluate(() => window.desktop.cancel());
  after = await snapshot();
  assert.equal(state.status, 'completed', state.events.at(-1)?.message);
  assert.equal(after.complete, true);
  assert.equal(tabs(after).length, tabs(before).length + 1, 'Native tab inventory must increase by exactly one');
  assert.equal(attemptedCreations, 1);
  assert.ok(tabs(after).some(t => t.states?.includes('selected') && t.name?.startsWith('New Tab')));
  console.log('PASS: exactly one new native Chrome tab, selected, and task completed.');
} catch (error) {
  failure = error.message;
  throw error;
} finally {
  const metrics = { success: !failure, failure, elapsedMs, decisions: state?.step,
    supervisorCalls: session.requests.filter(r => r.route === '/navigation/supervise').length,
    attemptedCreations, tabsBefore: tabs(before).length, tabsAfter: after ? tabs(after).length : null };
  writeFileSync('.runtime/new-tab-ui-smoke.json', JSON.stringify({ metrics, events, state, requests: session.requests }, null, 2));
  console.log('METRICS: ' + JSON.stringify(metrics));
  await session.close();
}
