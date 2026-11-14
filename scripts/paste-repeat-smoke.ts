import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { WorkspaceDesktopBridge } from '../apps/desktop/electron/desktop/workspace';
import { desktopCandidates } from '../apps/desktop/electron/controller/desktop-candidates';
import { TaskInputSchema } from '../packages/contracts/src/index';

const root = process.cwd();
const state = JSON.parse(readFileSync(root + '/.runtime/paste-jev-state.json', 'utf8'));
const text =
  process.env.ASSISTANT_PASTE_SMOKE_TEXT || 'Hi — this draft was filled with the generic paste tool. Café 😊';
assert.equal(state.observation.context.app, 'Microsoft Outlook');
const bridge = new WorkspaceDesktopBridge(
  root + '/.runtime/native/agent-desktop',
  root + '/.runtime/ui-native-state',
);
const task = TaskInputSchema.parse({ goal: 'Fill this body with the supplied text', text, provider: 'jev' });
const reports = [];
let observation = await bridge.observe(state.observation.context);
for (let repeat = 0; repeat < 2; repeat++) {
  const candidate = desktopCandidates(observation, task).find(
    (action) =>
      action.operation === 'FOCUS_AND_PASTE' &&
      action.inputId === 'text_1' &&
      action.description.includes('Body'),
  );
  assert.ok(candidate, 'The observed body must remain focused and readable');
  await bridge.act(candidate, observation, text, false, new AbortController().signal);
  const report = bridge.takeActionReport()!;
  assert.equal(report.verification, 'already_satisfied');
  assert.equal(report.delivery, 'not_delivered');
  assert.equal(report.observedValue, text + '\n');
  reports.push(report);
  observation = await bridge.observe(observation.context);
  assert.ok(
    observation.snapshots
      .flatMap((snapshot) => snapshot.elements)
      .some((element) => element.value === text + '\n'),
  );
}
writeFileSync(root + '/.runtime/paste-repeat-smoke.json', JSON.stringify({ reports, sent: false }, null, 2));
console.log('PASS: two repeated paste requests, zero additional pastes, exactly one body copy.');
