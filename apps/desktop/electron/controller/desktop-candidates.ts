import type {
  DesktopObservation,
  DesktopCandidate,
  TaskInput,
} from '../../../../packages/contracts/src/index';
import { KEYS } from '../desktop/workspace';
import { exactInputs } from './task-instructions';
import { canFocusAndPaste } from '../desktop/focus-and-paste';
import { browserCandidates } from '../browser/candidates';

export function desktopCandidates(
  observation: DesktopObservation,
  input: TaskInput,
): DesktopCandidate[] {
  if (observation.context.driver === 'browser') return browserCandidates(observation, input);
  const result: DesktopCandidate[] = [];
  const add = (candidate: Omit<DesktopCandidate, 'id'>) =>
    result.push({ ...candidate, id: 'action_' + result.length });
  const inputs = exactInputs(input),
    context = observation.context;
  for (const snapshot of observation.snapshots) {
    for (const element of snapshot.elements) {
      if (element.states.includes('hidden')) continue;
      const base = {
        app: snapshot.app,
        windowId: snapshot.windowId || undefined,
        snapshotId: snapshot.id,
        targetRef: element.ref,
        role: element.role,
        name: (element.name || element.description || element.nativeId || element.role).slice(0, 1000),
        bounds: element.bounds,
      };
      const details = [
        element.path,
        element.description,
        element.nativeId ? 'native identifier=' + element.nativeId : undefined,
        'value=' + element.value.slice(0, 500),
        'states=' + element.states.join(','),
      ]
        .filter(Boolean)
        .join('; ')
        .slice(0, 1300);
      const expandable = (element.childrenCount || 0) > 0 && element.ref !== context.rootRef;
      if (expandable)
        add({
          ...base,
          operation: 'INSPECT_REGION',
          description:
            'Fetch the next hierarchy chunk of this branch (' +
            element.childrenCount +
            ' children not yet read). No desktop input. ' +
            details,
        });
      if (snapshot.complete && canFocusAndPaste(element)) {
        const description =
          'Focus this text editor and replace its ENTIRE contents with exact text using the clipboard. ' +
          'Verifies focus and full selection, pastes once, reads back the result, and restores the clipboard. ' +
          'Use when whole-field replacement is intended, including focused editors without semantic typing support. ';
        for (const supplied of inputs)
          add({
            ...base,
            operation: 'FOCUS_AND_PASTE',
            inputId: supplied.id,
            description: description + 'Use ' + supplied.id + '. ' + details,
          });
        add({
          ...base,
          operation: 'FOCUS_AND_PASTE',
          inputFromGoal: true,
          description:
            description + 'Resolve exact field text from the instruction before pasting. ' + details,
        });
      }
      if (element.states.includes('disabled')) continue;
      if (!snapshot.complete) {
        if (
          !expandable &&
          element.ref !== context.rootRef &&
          ['group', 'scrollarea', 'outline', 'table', 'window', 'list', 'webarea'].includes(element.role)
        )
          add({
            ...base,
            operation: 'INSPECT_REGION',
            description: 'Read this subtree in more detail. ' + details,
          });
        continue;
      }
      if (element.states.includes('offscreen')) {
        if (element.actions.includes('ScrollTo'))
          add({ ...base, operation: 'SCROLL_TO', description: 'Reveal this offscreen control. ' + details });
        continue;
      }
      const operations: [string, DesktopCandidate['operation']][] = [
        ['Click', 'CLICK'],
        ['SetFocus', 'FOCUS'],
        ['RightClick', 'RIGHT_CLICK'],
        ['Expand', 'EXPAND'],
        ['Collapse', 'COLLAPSE'],
      ];
      if (input.allowPhysical) operations.push(['Click', 'DOUBLE_CLICK']);
      for (const [action, operation] of operations)
        if (element.actions.includes(action)) {
          if (operation === 'FOCUS' && element.states.includes('focused')) continue;
          if (
            expandable &&
            ['group', 'scrollarea', 'outline', 'table', 'list', 'webarea'].includes(element.role) &&
            ['CLICK', 'FOCUS', 'DOUBLE_CLICK', 'RIGHT_CLICK'].includes(operation)
          )
            continue;
          add({ ...base, operation, description: operation + ' this control. ' + details });
        }
      if (element.actions.includes('Toggle') || element.actions.includes('Check'))
        add({ ...base, operation: 'CHECK', description: 'Set checked/on. ' + details });
      if (element.actions.includes('Toggle') || element.actions.includes('Uncheck'))
        add({ ...base, operation: 'UNCHECK', description: 'Set unchecked/off. ' + details });
      if (
        !element.states.includes('readonly') &&
        [
          'textfield',
          'textarea',
          'combobox',
          'searchfield',
          'text',
          'editabletext',
          'listbox',
          'popupbutton',
        ].includes(element.role)
      ) {
        for (const supplied of inputs) {
          for (const [action, operation] of [
            ['SetValue', 'SET_VALUE'],
            ['Type', 'TYPE'],
            ['Select', 'SELECT'],
          ] as const) {
            if (
              element.actions.includes(action) ||
              (operation === 'TYPE' && element.actions.includes('TypeText'))
            )
              add({
                ...base,
                operation,
                inputId: supplied.id,
                description:
                  (operation === 'SET_VALUE'
                    ? 'Replace entire value with '
                    : operation === 'TYPE'
                      ? 'Insert at current caret: '
                      : 'Select option named ') +
                  supplied.id +
                  '. ' +
                  details,
              });
          }
        }
        for (const [action, operation] of [
          ['SetValue', 'SET_VALUE'],
          ['TypeText', 'TYPE'],
        ] as const) {
          if (element.actions.includes(action) || (operation === 'TYPE' && element.actions.includes('Type')))
            add({
              ...base,
              operation,
              inputFromGoal: true,
              description:
                (operation === 'SET_VALUE' ? 'Fill this field' : 'Insert at its caret') +
                ' with the relevant text extracted from the user instruction. No quotes or separate input needed. A separate Jev step resolves and checks the exact text before typing. ' +
                details,
            });
        }
      }
      if (element.actions.includes('Scroll'))
        for (const direction of ['down', 'up', 'left', 'right'] as const)
          add({
            ...base,
            operation: 'SCROLL',
            direction,
            description: 'Scroll ' + direction + ' by three units. ' + details,
          });
    }
    if (
      snapshot.complete &&
      context.windowId &&
      observation.windows.some((w) => w.id === context.windowId && w.focused)
    ) {
      for (const key of KEYS)
        add({
          app: snapshot.app,
          windowId: context.windowId,
          snapshotId: snapshot.id,
          operation: 'PRESS',
          key,
          name: key,
          description:
            'Send ' +
            key +
            ' to the observed focused window. Only use when this shortcut advances the explicit task.',
        });
    }
  }
  if (context.app) {
    add({ operation: 'WAIT', app: context.app, name: 'Wait and read again',
      description: 'Wait briefly for pending UI changes, then read fresh state. Sends no desktop input.' });
    for (const surface of ['window', 'menubar', 'menu', 'sheet', 'alert', 'popover', 'focused']) {
      if (surface === context.surface && !context.rootRef) continue;
      if (surface === 'window' && !context.windowId) continue;
      add({
        operation: 'READ_SURFACE',
        app: context.app,
        surface,
        name: surface,
        description:
          'Inspect the app’s ' +
          surface +
          ' accessibility tree. Menubar contains File, Edit, View and other application menus. This only reads the UI.',
      });
    }
    for (const window of observation.windows)
      if (window.id !== context.windowId)
        add({
          operation: 'READ_WINDOW',
          app: context.app,
          windowId: window.id,
          name: window.title || window.id,
          description:
            'Inspect this observed window without changing focus. It may contain autocomplete choices or a dialog: ' +
            window.title,
        });
    for (const window of observation.windows)
      if (!window.focused || window.id !== context.windowId)
        add({
          operation: 'FOCUS_WINDOW',
          app: context.app,
          windowId: window.id,
          name: window.title || window.id,
          description: 'Select and bring this observed window to front: ' + window.title,
        });
  }
  for (const app of observation.applications) {
    if (app.name === context.app && app.running && observation.snapshots.length) continue;
    add({
      operation: 'OPEN_APP',
      app: app.id,
      name: app.name,
      description: (app.running ? 'Switch to running app: ' : 'Launch installed app: ') + app.name,
    });
  }
  // Surface/window navigation remains discoverable before long lists of controls.
  add({
    operation: 'SEARCH_APPS',
    app: 'macOS',
    name: 'Find an application with Spotlight',
    inputFromGoal: true,
    description:
      'Search the macOS Spotlight application index for the app named in the user instruction. Use when the requested app is missing from the app inventory. Returns verified launch choices, including nested installations; does not launch anything yet.',
  });
  return result.sort(
    (a, b) =>
      Number(['READ_WINDOW', 'READ_SURFACE', 'FOCUS_WINDOW', 'SEARCH_APPS'].includes(b.operation)) -
      Number(['READ_WINDOW', 'READ_SURFACE', 'FOCUS_WINDOW', 'SEARCH_APPS'].includes(a.operation)),
  );
}
