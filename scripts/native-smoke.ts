import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { NativeDesktopBridge } from '../apps/desktop/electron/desktop/native';
import { resolveNativeBinary } from '../apps/desktop/electron/desktop/native-binary';
import { NavigationController } from '../apps/desktop/electron/controller/navigation';
import { LocalTestPolicy } from '../apps/desktop/electron/services/decision-client';

const root = process.cwd();
const bridge = new NativeDesktopBridge(
  resolveNativeBinary(root),
  path.join(root, '.runtime', 'native-smoke-state'),
);
const health = await bridge.health();
assert.equal(health.accessibility, 'granted', 'Accessibility permission is required for the launching app.');
const policy = new LocalTestPolicy();
const controller = new NavigationController(bridge, { local: policy, jev: policy });
let lastEvent = 0;
const finished = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => {
    controller.cancel();
    reject(new Error('Native test timed out.'));
  }, 45_000);
  controller.subscribe((state) => {
    for (const event of state.events.filter((e) => e.id > lastEvent)) {
      console.log(event.type + ': ' + event.message);
      lastEvent = event.id;
    }
    if (state.taskId && !state.busy) {
      clearTimeout(timeout);
      state.status === 'completed'
        ? resolve()
        : reject(new Error('Task ended as ' + state.status + ': ' + state.events.at(-1)?.message));
    }
  });
});
controller.start({
  mode: 'textedit' as const,
  goal: 'Enter the supplied greeting in this fresh TextEdit document.',
  text: 'Hello Alex',
  provider: 'local',
  maxSteps: 8,
});
await finished;
const result = controller.state();
assert.equal(result.verifiedText, 'Hello Alex');
assert.equal(result.step, 1);
mkdirSync(path.join(root, '.runtime'), { recursive: true });
writeFileSync(
  path.join(root, '.runtime', 'native-smoke-result.json'),
  JSON.stringify(
    {
      testedAt: new Date().toISOString(),
      nativeVersion: health.version,
      provider: 'local',
      liveJevTested: false,
      status: result.status,
      windowId: result.document?.windowId,
      windowTitle: result.document?.windowTitle,
      verifiedText: result.verifiedText,
      steps: result.step,
    },
    null,
    2,
  ),
);
console.log('PASS: real TextEdit text verified through native accessibility; no live Jev call.');

// Exercise the general controller's text verification against the owned test document.
const { WorkspaceDesktopBridge } = await import('../apps/desktop/electron/desktop/workspace');
const workspace = new WorkspaceDesktopBridge(bridge.binary, bridge.stateRoot);
let observed = await workspace.observe({ app: 'TextEdit', windowId: result.document!.windowId });
const text = 'Hello café 😊';
for (const [operation, supplied] of [
  ['SET_VALUE', text],
  ['TYPE', '!'],
] as const) {
  const snapshot = observed.snapshots[0];
  const editors = snapshot.elements.filter(
    (element) => element.nativeId === 'First Text View' && element.actions.includes('SetValue'),
  );
  assert.equal(editors.length, 1);
  const target = editors[0];
  const candidate = {
    id: 'test-write',
    operation,
    app: 'TextEdit',
    windowId: snapshot.windowId,
    snapshotId: snapshot.id,
    targetRef: target.ref,
    name: 'Document body',
    description: 'Owned test document',
  };
  await workspace.act(candidate, observed, supplied, false, new AbortController().signal);
  const report = workspace.takeActionReport()!;
  assert.equal(report.verification, 'verified');
  assert.equal(report.observedValue, report.expectedValue);
  observed = await workspace.observe(observed.context);
}
const snapshot = observed.snapshots[0];
const editor = snapshot.elements.find((element) => element.nativeId === 'First Text View')!;
assert.equal(editor.value.replace('!', ''), text);
assert.equal(editor.value.split('!').length - 1, 1);
await workspace.act(
  {
    id: 'already-filled',
    operation: 'SET_VALUE',
    app: 'TextEdit',
    windowId: snapshot.windowId,
    snapshotId: snapshot.id,
    targetRef: editor.ref,
    name: 'Document body',
    description: 'Idempotent write',
  },
  observed,
  editor.value,
  false,
  new AbortController().signal,
);
assert.equal(workspace.takeActionReport()!.verification, 'already_satisfied');
console.log(
  'PASS: general bridge Unicode replacement, native insertion and duplicate-free idempotent write.',
);

const pastedText = 'Generic paste\nSecond line café 😊';
const pasteReports = [];
for (let attempt = 0; attempt < 2; attempt++) {
  // Semantic text actions can work without foreground focus; paste deliberately cannot.
  // Focus only this owned test window before taking the paste observation.
  await workspace.act({ id: 'focus-owned', operation: 'FOCUS_WINDOW', app: 'TextEdit',
    windowId: result.document!.windowId, name: 'Owned test document', description: 'Focus paste fixture' },
    observed, undefined, false, new AbortController().signal);
  observed = await workspace.observe(observed.context);
  const snapshot = observed.snapshots[0];
  const editor = snapshot.elements.find((element) => element.nativeId === 'First Text View')!;
  await workspace.act(
    {
      id: 'paste-editor',
      operation: 'FOCUS_AND_PASTE',
      app: 'TextEdit',
      windowId: snapshot.windowId,
      snapshotId: snapshot.id,
      targetRef: editor.ref,
      name: 'Document body',
      description: 'Replace full text in owned test document',
    },
    observed,
    pastedText,
    false,
    new AbortController().signal,
  );
  const report = workspace.takeActionReport()!;
  assert.equal(report.verification, attempt === 0 ? 'verified' : 'already_satisfied');
  assert.equal(report.observedValue, pastedText);
  pasteReports.push(report);
  observed = await workspace.observe(observed.context);
}
writeFileSync(
  path.join(root, '.runtime', 'paste-textedit-smoke.json'),
  JSON.stringify({ pasteReports }, null, 2),
);
console.log('PASS: generic focus-and-paste in TextEdit, multiline Unicode, repeat suppressed.');
