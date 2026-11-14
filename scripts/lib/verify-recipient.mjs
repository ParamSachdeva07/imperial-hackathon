import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import path from 'node:path';

const execute = promisify(execFile);
function nodes(tree) {
  return tree ? [tree, ...(tree.children || []).flatMap(nodes)] : [];
}

export async function verifyRecipient(root, state) {
  const run = async (args) => {
    const { stdout } = await execute(path.join(root, '.runtime/native/agent-desktop'), args, {
      env: { ...process.env, AGENT_DESKTOP_HOME: path.join(root, '.runtime/ui-native-state') },
      maxBuffer: 4 * 1024 * 1024,
    });
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true, JSON.stringify(response.error));
    assert.equal(response.data.complete, true, 'Verification requires a complete scope');
    return response.data;
  };
  const snapshot = await run([
    'snapshot',
    '--app',
    'Microsoft Outlook',
    '--window-id',
    state.snapshot.windowId,
    '--skeleton',
    '--compact',
    '--max-depth',
    '3',
  ]);
  const fields = nodes(snapshot.tree);
  const recipient = fields.find((node) => node.name === 'To Recipients');
  const subject = fields.find((node) => node.name === 'Subject');
  assert.ok(recipient?.ref_id, 'Recipient control must exist');
  assert.equal(subject?.value, 'Recipient verification test');
  const tokenScope = await run(['snapshot', '--root', recipient.ref_id, '--max-depth', '3', '--compact']);
  const tokens = nodes(tokenScope.tree).filter((node) => node.role === 'statictext');
  assert.equal(tokens.length, 1, 'Exactly one accepted recipient token');
  assert.match(tokens[0].value, /^zcabps0@ucl\.ac\.uk(?:,|$)/);
  assert.equal(tokenScope.tree.value, '\ufffc', 'Editor contains one committed object, not repeated input');
  const writes = state.events.filter(
    (event) =>
      event.type === 'result' &&
      event.details?.action?.target === 'To Recipients' &&
      ['TYPE', 'SET_VALUE'].includes(event.details.action.operation),
  );
  assert.equal(writes.length, 1, 'Recipient input dispatched exactly once');
  return {
    recipient: 'zcabps0@ucl.ac.uk',
    acceptedTokens: 1,
    recipientWrites: writes.length,
    subject: subject.value,
    modelStatus: state.status,
    sent: false,
  };
}
