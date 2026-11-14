import type { DesktopCandidate, DesktopObservation, TaskInput } from '../../../../packages/contracts/src/index';
import { exactInputs } from '../controller/task-instructions';

export function browserCandidates(observation: DesktopObservation, input: TaskInput): DesktopCandidate[] {
  const snapshot = observation.snapshots[0];
  if (!snapshot) return [];
  const candidates: DesktopCandidate[] = [];
  const base = { app: snapshot.app, windowId: snapshot.windowId, snapshotId: snapshot.id };
  const add = (candidate: Omit<DesktopCandidate, 'id'>) => candidates.push({ ...candidate, id: 'web_' + candidates.length });
  const textChoice = (candidate: Omit<DesktopCandidate, 'id'>) => {
    for (const supplied of exactInputs(input)) add({ ...candidate, inputId: supplied.id });
    add({ ...candidate, inputFromGoal: true });
  };
  textChoice({ ...base, operation: 'NAVIGATE', name: 'Website address', role: 'addressbar',
    description: 'Open the website address supplied in the instruction in this browser tab. Use for navigating to a website, not for an in-page search. Current URL: ' + snapshot.browser!.url });
  for (const element of snapshot.elements) {
    if (element.states.some(s => ['hidden', 'disabled'].includes(s))) continue;
    const target = { ...base, targetRef: element.ref, role: element.role, name: element.name || element.role };
    const details = element.description + '; current value=' + element.value.slice(0, 500);
    for (const [capability, operation] of [['Click', 'CLICK'], ['SetFocus', 'FOCUS'], ['Check', 'CHECK'], ['Uncheck', 'UNCHECK']] as const)
      if (element.actions.includes(capability)) add({ ...target, operation, description: operation + ' this observed page control. ' + details });
    if (element.actions.includes('SetValue')) textChoice({ ...target, operation: 'SET_VALUE',
      description: 'Replace the entire value of this page field with the relevant supplied text. Submitting the field is a separate action. ' + details });
  }
  for (const key of ['Enter', 'Escape', 'Tab', 'Shift+Tab', 'Space', 'ArrowDown', 'ArrowUp'])
    add({ ...base, operation: 'PRESS', key, name: key, description: 'Send ' + key + ' to the observed focused control in this tab. Check which control is focused first.' });
  for (const direction of ['down', 'up', 'left', 'right'] as const)
    add({ ...base, operation: 'SCROLL', direction, name: direction, description: 'Scroll the page ' + direction + ' to reveal more content.' });
  for (const operation of ['BACK', 'FORWARD', 'WAIT'] as const)
    add({ ...base, operation, name: operation, description: operation === 'WAIT' ? 'Observe again after allowing pending page changes to settle. Use only while expected content is loading.' : 'Navigate browser history ' + operation.toLowerCase() });
  for (const window of observation.windows)
    if (window.id !== snapshot.windowId) add({ ...base, operation: 'READ_WINDOW', windowId: window.id, name: window.title, description: 'Switch to this observed browser tab.' });
  for (const surface of ['window', 'menubar', 'menu', 'sheet', 'alert', 'popover'])
    add({ ...base, operation: 'READ_SURFACE', surface, name: 'Native ' + surface, description: 'Read the native browser ' + surface + ' using desktop accessibility, for controls outside the web page.' });
  for (const app of observation.applications)
    add({ operation: 'OPEN_APP', app: app.id, name: app.name, description: 'Launch or switch to the observed application ' + app.name });
  add({ ...base, operation: 'BROWSE_APPS', name: 'Applications', description: 'Browse installed applications to switch away from this page.' });
  return snapshot.browser?.contentPending
    ? candidates.filter(c => ['WAIT', 'READ_SURFACE', 'BROWSE_APPS', 'OPEN_APP'].includes(c.operation))
    : candidates;
}
