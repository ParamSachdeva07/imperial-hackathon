import { smokeSession } from './lib/smoke-session.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// This fixture has explicit user authorization to send exactly one test email.
// All Outlook interaction still runs through the production controller.
process.env.ASSISTANT_BROWSER_DRIVER = 'native';
const root = process.cwd(), app = 'Microsoft Outlook';
const recipient = 'zcabps0@ucl.ac.uk', subject = 'Desktop Assistant test', body = 'Hi';
const execute = promisify(execFile);
const nodes = tree => tree ? [tree, ...(tree.children || []).flatMap(nodes)] : [];
async function native(args) {
  const { stdout } = await execute(root + '/.runtime/native/agent-desktop', args, {
    env: { ...process.env, AGENT_DESKTOP_HOME: root + '/.runtime/ui-native-state' }, maxBuffer: 8 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data;
}
async function readWindow(id) {
  return native(['snapshot', '--app', app, '--window-id', id, '--skeleton', '--compact', '--max-depth', '3']);
}
async function readField(ref) {
  return native(['snapshot', '--root', ref, '--compact', '--max-depth', '4']);
}
let sendProposal = false, preSend, state;
const reads = new Set(['BROWSE_TREE','BROWSE_APPS','READ_SURFACE','READ_WINDOW','INSPECT_REGION','SEARCH_APPS','WAIT']);
const session = await smokeSession('jev', async (request, decision) => {
  const c = request.candidates.find(c => c.id === decision.candidateId);
  if (!c || reads.has(c.operation) || decision.goalCompletionProbability > .5) return;
  assert.ok([app, 'com.microsoft.Outlook'].includes(c.app), 'Only Outlook may be mutated');
  assert.ok(!/^(delete|discard|archive|move|junk|forward|reply)\b/i.test(c.name), 'Do not modify unrelated mail');
  if (c.operation === 'PRESS') assert.ok(['cmd+n','return','escape','tab','shift+tab','cmd+a','space','up','down'].includes(c.key));
  if (['TYPE','SET_VALUE','FOCUS_AND_PASTE'].includes(c.operation)) {
    assert.ok(!sendProposal, 'No new text after the send attempt');
    assert.match(c.name + ' ' + c.description, /To Recipients|Subject|Body|textfield|search/i);
  }
  if (c.operation === 'CLICK' && /^Send(?:\s|$)/i.test(c.name)) {
    assert.equal(sendProposal, false, 'Send must only be attempted once; inspect Sent before retrying');
    const snapshot = await readWindow(c.windowId);
    assert.equal(snapshot.complete, true);
    const fields = nodes(snapshot.tree);
    const to = fields.find(n => n.name === 'To Recipients');
    const subj = fields.find(n => n.name === 'Subject');
    const editor = fields.find(n => n.name === 'Body');
    assert.equal(subj?.value, subject, 'Exact subject before Send');
    assert.ok(to?.ref_id && editor?.ref_id, 'Recipient and body must be observed before Send');
    const tokens = await readField(to.ref_id);
    const content = await readField(editor.ref_id);
    assert.ok(tokens.complete && content.complete, 'Complete fields before Send');
    const accepted = nodes(tokens.tree).filter(n => n.role === 'statictext' && (n.value || '').includes(recipient));
    assert.equal(accepted.length, 1, 'Exactly one accepted intended recipient');
    assert.equal(tokens.tree.value, '\ufffc', 'Recipient is committed, not unaccepted input');
    const texts = nodes(content.tree).filter(n => n.role === 'textfield');
    assert.equal(texts.length, 1, 'One readable message body');
    assert.equal(texts[0].value.trim(), body, 'Exact body once before Send');
    preSend = { recipient, subject, body: texts[0].value, checkedAt: new Date().toISOString(), windowId: c.windowId };
    writeFileSync(root + '/.runtime/outlook-send-preflight.json', JSON.stringify(preSend, null, 2));
    sendProposal = true;
  }
});
const goal = `In Microsoft Outlook, create a NEW email to "${recipient}" with subject "${subject}" and body "${body}". Send this email once. Then open Sent and select that sent message to verify its recipient, subject and body. Preserve unrelated drafts and messages.`;
const evidence = [];
const started = performance.now();
try {
  await session.page.getByLabel('What would you like to do?').fill(goal);
  await session.page.getByRole('button', { name: 'Send instruction', exact: true }).click();
  let lastEvent = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    state = (await session.page.evaluate(() => window.desktop.state())).data;
    if (state.observation && evidence.at(-1)?.id !== state.observation.id) evidence.push(state.observation);
    for (const event of state.events.filter(e => e.id > lastEvent)) {
      if (['observation','decision','result','error'].includes(event.type)) console.log(event.type + ': ' + event.message);
      lastEvent = event.id;
    }
    if (state.taskId && !state.busy) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (state?.busy) await session.page.evaluate(() => window.desktop.cancel());
  const metrics = { elapsedMs: performance.now() - started, decisions: state?.step,
    supervisorCalls: session.requests.filter(r => r.route === '/navigation/supervise').length,
    model: session.backendHealth.supervisorModel, effort: session.backendHealth.supervisorReasoningEffort };
  const report = { state, evidence, metrics, sendProposal, preSend, requests: session.requests };
  writeFileSync(root + '/.runtime/outlook-send-native-state.json', JSON.stringify(report, null, 2));
  console.log('METRICS: ' + JSON.stringify(metrics));
  console.log('STATUS: ' + state?.status + '; Send proposed: ' + sendProposal);
  assert.ok(sendProposal && preSend, 'Must reach independently verified Send');
  assert.equal(state?.status, 'completed', 'Controller must complete Sent verification');
  // The report is followed by an independent native Sent read by the test operator.
} finally { await session.close(); }
