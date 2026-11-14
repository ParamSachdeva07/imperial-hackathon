import { smokeSession } from './lib/smoke-session.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Exercise the actual Electron → Jev → native AX loop. No CDP or WebDriver.
const goal = 'Open Safari, open youtube.com, search rag on YouTube, and play a video.';
const reads = ['BROWSE_TREE', 'BROWSE_APPS', 'READ_SURFACE', 'READ_WINDOW', 'INSPECT_REGION'];
const session = await smokeSession('jev', (request, decision) => {
  const action = request.candidates.find(c => c.id === decision.candidateId);
  if (!action) return;
  assert.notEqual(request.context.driver, 'browser', 'Safari test must stay on native accessibility');
  const safe = reads.includes(action.operation) ||
    (action.operation === 'OPEN_APP' && ['Safari', 'com.apple.Safari'].includes(action.app)) ||
    (action.app === 'Safari' && (
      ['FOCUS_WINDOW', 'FOCUS', 'SCROLL', 'SCROLL_TO'].includes(action.operation) ||
      (['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE'].includes(action.operation) && /search|address|website/i.test(action.name)) ||
      (action.operation === 'PRESS' && ['return', 'escape', 'tab', 'shift+tab', 'cmd+l', 'cmd+t', 'space'].includes(action.key)) ||
      (action.operation === 'CLICK' && /rag|retrieval|^YouTube Home$|search|address|website|^accept|^reject|^play|^pause|^skip ad|^not now|^continue|^start using/i.test(action.name) &&
        !/subscribe|like|comment|share|download|save/i.test(action.name))
    ));
  assert.ok(safe, 'Safari test blocked an out-of-scope action: ' + action.operation + ' ' + action.name);
});
try {
  const page = session.page;
  await page.getByRole('heading', { name: 'Desktop Assistant' }).waitFor();
  await page.getByLabel('What would you like to do?').fill(goal);
  await page.getByRole('button', { name: 'Send instruction', exact: true }).click();
  let state, lastEvent = 0;
  const evidence = [];
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.desktop.state());
    assert.equal(result.ok, true);
    state = result.data;
    if (state.observation && evidence.at(-1)?.id !== state.observation.id)
      evidence.push(state.observation);
    for (const event of state.events.filter(e => e.id > lastEvent)) {
      if (['observation', 'decision', 'result', 'error'].includes(event.type)) console.log(event.type + ': ' + event.message);
      lastEvent = event.id;
    }
    if (state.taskId && !state.busy) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  writeFileSync(path.join(process.cwd(), '.runtime/safari-native-state.json'), JSON.stringify({ state, evidence }, null, 2));
  console.log(JSON.stringify({ status: state?.status, steps: state?.step, driver: state?.observation?.context.driver,
    context: state?.observation?.context, events: state?.events.slice(-8).map(e => e.message) }, null, 2));
  assert.equal(state?.status, 'completed', 'Safari task must reach model-assessed completion');
  assert.ok(evidence.every(o => o.context.driver !== 'browser'), 'No browser debugging adapter may be used');
  console.log('Model loop completed through native accessibility. Independently verify playback using fresh AX reads.');
} finally {
  await session.close();
}
