import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { smokeSession } from './lib/smoke-session.mjs';

const root = process.cwd();
const text =
  process.env.ASSISTANT_PASTE_SMOKE_TEXT || 'Hi — this draft was filled with the generic paste tool. Café 😊';
const execute = promisify(execFile);
const native = async (args) => {
  const { stdout } = await execute(root + '/.runtime/native/agent-desktop', args, {
    env: { ...process.env, AGENT_DESKTOP_HOME: root + '/.runtime/ui-native-state' },
    maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data;
};
const nodes = (tree) => (tree ? [tree, ...(tree.children || []).flatMap(nodes)] : []);
const app = 'Microsoft Outlook';
const windows = await native(['list-windows', '--app', app]);
assert.equal(windows.length, 1, 'Select the existing verification draft, not an arbitrary window');
const windowId = windows[0].id;
async function draft(focusSubject = false) {
  const snapshot = await native([
    'snapshot',
    '--app',
    app,
    '--window-id',
    windowId,
    '--skeleton',
    '--max-depth',
    '3',
    '--compact',
  ]);
  assert.equal(snapshot.complete, true);
  const fields = nodes(snapshot.tree);
  assert.equal(fields.find((node) => node.name === 'Subject')?.value, 'Recipient verification test');
  const body = fields.find((node) => node.name === 'Body');
  assert.ok(body?.ref_id);
  const scope = await native(['snapshot', '--root', body.ref_id, '--max-depth', '3', '--compact']);
  assert.equal(scope.complete, true);
  if (focusSubject) {
    await native(['launch', 'com.microsoft.Outlook', '--activate']);
    await native(['focus', fields.find((node) => node.name === 'Subject').ref_id]);
  }
  return nodes(scope.tree).find((node) => node.role === 'textfield');
}
const before = await draft();
const previousReport = root + '/.runtime/paste-ui-smoke.json';
const previousValue = existsSync(previousReport)
  ? JSON.parse(readFileSync(previousReport, 'utf8')).observedValue
  : undefined;
assert.ok(
  before &&
    [
      '\n',
      'Hello from the generic paste tool. Café 😊\n',
      'Hi — this draft was filled with the generic paste tool. Café 😊\n',
      text + '\n',
      previousValue,
    ].includes(before.value),
  'Only modify the owned smoke-test draft',
);
if (process.env.ASSISTANT_SMOKE_START_SUBJECT === '1') await draft(true);
const selected = [];
const session = await smokeSession('jev', (request, decision) => {
  const action = request.candidates.find((candidate) => candidate.id === decision.candidateId);
  if (!action) return;
  const reading = ['BROWSE_TREE', 'BROWSE_APPS', 'READ_SURFACE', 'READ_WINDOW', 'INSPECT_REGION'];
  const safe =
    reading.includes(action.operation) ||
    (action.operation === 'OPEN_APP' &&
      ['Microsoft Outlook', 'com.microsoft.Outlook'].includes(action.app)) ||
    (action.operation === 'FOCUS_WINDOW' && action.windowId === windowId) ||
    (action.operation === 'FOCUS' && action.app === app && action.windowId === windowId) ||
    (action.operation === 'PRESS' && ['tab', 'shift+tab', 'escape'].includes(action.key)) ||
    (action.operation === 'FOCUS_AND_PASTE' && action.description.includes('Body'));
  assert.ok(safe, 'Body smoke blocked out-of-scope action: ' + action.operation + ' ' + action.name);
  selected.push({ operation: action.operation, name: action.name });
});
const { application, page } = session;
const clipboardHash = async () => {
  const formats = await application.evaluate(async ({ clipboard }) =>
    Promise.all(
      (await clipboard.read()).map(async (item) =>
        Promise.all(
          item.types.sort().map(async (type) => {
            const data = await item.getType(type);
            return [
              type,
              data.arrayBuffer
                ? Buffer.from(await data.arrayBuffer()).toString('base64')
                : JSON.stringify(data),
            ];
          }),
        ),
      ),
    ),
  );
  return createHash('sha256').update(JSON.stringify(formats)).digest('hex');
};
try {
  const originalClipboard = await clipboardHash();
  await page
    .getByLabel('What would you like to do?')
    .fill(
      'In Microsoft Outlook, replace the body of the currently open draft with "' +
        text +
        '". Leave the draft unsent.',
    );
  await page.getByRole('button', { name: 'Send instruction', exact: true }).click();
  let state,
    lastEvent = 0;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    state = (await page.evaluate(() => window.desktop.state())).data;
    for (const event of state.events.filter((event) => event.id > lastEvent)) {
      if (['observation', 'decision', 'result', 'error'].includes(event.type))
        console.log(event.type + ': ' + event.message);
      lastEvent = event.id;
    }
    if (state.taskId && !state.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  writeFileSync(root + '/.runtime/paste-jev-state.json', JSON.stringify(state, null, 2));
  const after = await draft();
  assert.equal(
    after?.value,
    text + '\n',
    'Body must contain precisely one requested copy and its paragraph marker',
  );
  assert.equal(await clipboardHash(), originalClipboard, 'Clipboard bytes and formats must be restored');
  const writes = state.events.filter((event) => event.details?.action?.operation === 'FOCUS_AND_PASTE');
  assert.equal(writes.length, 1, 'Jev must select the paste tool exactly once');
  assert.equal(
    writes[0].details.action.verification,
    before.value === text + '\n' ? 'already_satisfied' : 'verified',
  );
  const repeat = await execute(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/paste-repeat-smoke.ts'],
    { cwd: root },
  );
  console.log(repeat.stdout.trim());
  assert.equal(await clipboardHash(), originalClipboard, 'Duplicate requests must preserve the clipboard');
  const report = {
    model: state.decision?.model,
    status: state.status,
    text,
    observedValue: after.value,
    writes: writes.length,
    selected,
    clipboardRestored: true,
    sent: false,
  };
  writeFileSync(root + '/.runtime/paste-ui-smoke.json', JSON.stringify(report, null, 2));
  console.log(
    'PASS: Jev → FOCUS_AND_PASTE → exact body once; clipboard restored; draft unsent. Model completion status: ' +
      state.status,
  );
} finally {
  await session.close();
}
