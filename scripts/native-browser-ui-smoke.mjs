import { smokeSession } from './lib/smoke-session.mjs';
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';

// Actual Electron → Jev → native Accessibility. Playwright drives our UI only.
process.env.ASSISTANT_BROWSER_DRIVER = 'native';
const app = process.env.ASSISTANT_SMOKE_APP || 'Google Chrome';
const firstVideo = process.env.ASSISTANT_SMOKE_SCENARIO === 'first-video';
const prefix = (app === 'Safari' ? 'safari' : 'chrome') + (firstVideo ? '-first-video' : process.env.ASSISTANT_SMOKE_GOAL ? '-specific-video' : '');
const expectedTitle = process.env.ASSISTANT_SMOKE_EXPECTED_TITLE;
const goal = process.env.ASSISTANT_SMOKE_GOAL || (firstVideo ? `In ${app}, play the first video at the top of the currently open YouTube search results.` :
  `Open youtube.com in ${app}, then search rag on YouTube, then play a video about rag.`);
const reads = ['BROWSE_TREE', 'BROWSE_APPS', 'READ_SURFACE', 'READ_WINDOW', 'INSPECT_REGION', 'WAIT', 'SEARCH_APPS'];
const session = await smokeSession('jev', (request, decision) => {
  const action = request.candidates.find(c => c.id === decision.candidateId);
  if (!action) return;
  assert.notEqual(request.context.driver, 'browser', 'Test must stay on native accessibility');
  const safe = reads.includes(action.operation) ||
    (action.operation === 'OPEN_APP' && [app, app === 'Safari' ? 'com.apple.Safari' : 'com.google.Chrome'].includes(action.app)) ||
    (action.app === app && (
      ['FOCUS_WINDOW', 'FOCUS', 'SCROLL', 'SCROLL_TO'].includes(action.operation) ||
      (['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE'].includes(action.operation) && /search|address|website/i.test(action.name)) ||
      (action.operation === 'PRESS' && ['return', 'escape', 'tab', 'shift+tab', 'cmd+l', 'cmd+t', 'space'].includes(action.key)) ||
      (action.operation === 'CLICK' && ['tab', 'radiobutton'].includes(action.role) && /^YouTube(?: -|$)/.test(action.name)) ||
      (action.operation === 'CLICK' && /rag|retrieval|^New Tab$|^YouTube Home$|search|address|website|^accept|^reject|^play|^pause|^mute\b|^unmute\b|^skip ad|^not now|^continue|^start using/i.test(action.name) &&
        !/subscribe|like|comment|share|download|save/i.test(action.name))
    ));
  assert.ok(safe, 'Native browser test blocked an out-of-scope action: ' + action.operation + ' ' + action.name);
});
const execute = promisify(execFile);
const flatten = node => node ? [node, ...(node.children || []).flatMap(flatten)] : [];
async function playbackSample(context) {
  const args = ['snapshot', '--compact', '--max-depth', '12'];
  if (context.rootRef) args.push('--root', context.rootRef);
  else args.push('--app', app, '--window-id', context.windowId);
  const { stdout } = await execute(path.join(process.cwd(), '.runtime/native/agent-desktop'), args, {
    env: { ...process.env, AGENT_DESKTOP_HOME: path.join(process.cwd(), '.runtime/ui-native-state') },
    maxBuffer: 8 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.data.complete, true, 'Independent playback scope must be complete');
  const nodes = flatten(result.data.tree).filter(n => !(n.states || []).some(s => ['offscreen', 'hidden', 'disabled'].includes(s)));
  const pause = nodes.find(n => n.role === 'button' && /^pause\b/i.test(n.name || n.description || ''));
  const seek = nodes.filter(n => n.role === 'slider' && /seek/i.test(n.name || '') && /^\d+(\.\d+)?$/.test(String(n.value)));
  assert.ok(pause, 'Fresh native read must expose active Pause control');
  assert.equal(seek.length, 1, 'Fresh native read must identify one video timeline');
  return { capturedAt: Date.now(), snapshotId: result.data.snapshot_id, title: result.data.window?.title,
    pause: pause.name, position: Number(seek[0].value) };
}
try {
  const started = performance.now();
  const page = session.page;
  await page.getByRole('heading', { name: 'Desktop Assistant' }).waitFor();
  await page.getByLabel('What would you like to do?').fill(goal);
  await page.getByRole('button', { name: 'Send instruction', exact: true }).click();
  let state, lastEvent = 0;
  const evidence = [];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.desktop.state());
    assert.equal(result.ok, true);
    state = result.data;
    if (state.observation && evidence.at(-1)?.id !== state.observation.id) evidence.push(state.observation);
    for (const event of state.events.filter(e => e.id > lastEvent)) {
      if (['observation', 'decision', 'result', 'error'].includes(event.type)) console.log(event.type + ': ' + event.message);
      lastEvent = event.id;
    }
    if (state.taskId && !state.busy) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (state?.busy) await page.evaluate(() => window.desktop.cancel());
  const metrics = { elapsedMs: performance.now() - started, decisions: state?.step,
    supervisorCalls: session.requests.filter(r => r.route === '/navigation/supervise').length,
    model: session.backendHealth.supervisorModel, effort: session.backendHealth.supervisorReasoningEffort };
  writeFileSync(path.join(process.cwd(), `.runtime/${prefix}-native-state.json`), JSON.stringify({ state, evidence, metrics, requests: session.requests }, null, 2));
  console.log('METRICS: ' + JSON.stringify(metrics));
  console.log(JSON.stringify({ status: state?.status, steps: state?.step, context: state?.observation?.context,
    events: state?.events.slice(-8).map(e => e.message) }, null, 2));
  assert.equal(state?.status, 'completed', 'Native browser task must reach verified completion');
  assert.ok(evidence.every(o => o.context.driver !== 'browser'), 'No browser debugging adapter may be used');
  const fields = evidence.flatMap(o => o.snapshots.flatMap(s => s.elements));
  assert.ok(fields.some(e => /youtube\.com\/results\?/.test(e.value) && /rag/i.test(decodeURIComponent(e.value))), 'Must observe the requested RAG search results URL');
  const { stdout: windowJson } = await execute(path.join(process.cwd(), '.runtime/native/agent-desktop'),
    ['snapshot', '--app', app, '--window-id', state.observation.context.windowId, '--skeleton', '--compact', '--max-depth', '3'],
    { env: { ...process.env, AGENT_DESKTOP_HOME: path.join(process.cwd(), '.runtime/ui-native-state') }, maxBuffer: 8 * 1024 * 1024 });
  const finalWindow = JSON.parse(windowJson);
  assert.equal(finalWindow.ok, true);
  const url = flatten(finalWindow.data.tree).find(n => /youtube\.com\/watch\?/.test(n.value || ''))?.value;
  assert.ok(url, 'Independent native read must observe a YouTube watch URL');
  if (process.env.ASSISTANT_SMOKE_EXPECTED_VIDEO) assert.ok(url.includes('v=' + process.env.ASSISTANT_SMOKE_EXPECTED_VIDEO), 'Must play the exact requested video');
  if (expectedTitle) assert.ok((finalWindow.data.window?.title || state.snapshot.windowTitle).includes(expectedTitle),
    'Opened video must match the top result recorded before the test');
  const before = await playbackSample(state.observation.context);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const after = await playbackSample(state.observation.context);
  assert.ok(after.position > before.position, 'Independent reads must show advancing video time');
  assert.match(after.title || state.snapshot.windowTitle, /rag|retrieval/i, 'Video title must relate to rag');
  writeFileSync(path.join(process.cwd(), `.runtime/${prefix}-native-playback.json`), JSON.stringify({ goal, url, expectedTitle, before, after }, null, 2));
  console.log(`PASS: ${app} native Accessibility → YouTube → rag search → active playback, ${before.position} → ${after.position}.`);
} finally {
  await session.close();
}
