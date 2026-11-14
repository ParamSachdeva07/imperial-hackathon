import { randomUUID } from 'node:crypto';
import type { BrowserPageState, DesktopObservation, Element } from '../../../../packages/contracts/src/index';

export type BrowserCapture = { snapshot: any; page: any; tabs: any[] };

export function browserObservation(capture: BrowserCapture, app: string, applications: DesktopObservation['applications']): DesktopObservation {
  const { snapshot, page, tabs } = capture;
  const tab = tabs.find(t => t.active);
  if (!tab) throw new Error('Browser did not identify its owned active tab.');
  const id = 'b' + randomUUID().replaceAll('-', '');
  const lines = String(snapshot.snapshot || '').split('\n');
  const elements: Element[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const attributes = [...line.matchAll(/\[([^\[\]]*\bref=(e\d+)\b[^\[\]]*)\]/g)].at(-1);
    const ref = attributes?.[2];
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const item = snapshot.refs?.[ref];
    if (!item) continue;
    const role = item.role === 'textbox' ? 'textfield' : String(item.role || 'group');
    const name = String(item.name || '');
    const fields = (page.fields || []).filter((field: any) => field.name === name);
    const field = ['textfield', 'searchbox', 'combobox', 'textarea', 'spinbutton'].includes(role) && fields.length === 1 ? fields[0] : undefined;
    const states = ['disabled', 'readonly', 'checked', 'selected'].filter(state =>
      new RegExp('(?:^|[, ])' + state + '(?:=true)?(?=[, ]|$)').test(attributes?.[1] || ''));
    if (field?.focused) states.push('focused');
    const editable = ['textfield', 'searchbox', 'combobox', 'textarea', 'spinbutton'].includes(role);
    const actions: string[] = [];
    if (['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'combobox'].includes(role) || line.includes('clickable')) actions.push('Click');
    if (editable && !states.includes('readonly')) actions.push('SetValue', 'SetFocus');
    if (['checkbox', 'switch'].includes(role)) actions.push('Check', 'Uncheck');
    elements.push({ ref: '@' + id + ':' + ref, nativeId: ref, nativeIdKind: 'browser_ref', role, name,
      value: String(field?.value || ''), states, actions, description: line.trim().slice(0, 1300) });
  }
  const browser: BrowserPageState = { url: page.url, title: page.title, documentId: page.documentId,
    tabId: tab.tabId, readyState: page.readyState, contentPending: !!page.contentPending, media: page.media || [] };
  const evidence = [
    'Browser page URL: ' + page.url, 'Browser page title: ' + page.title,
    'Page readiness: ' + page.readyState,
    'Page reports loading content: ' + !!page.busy,
    ...(page.contentPending ? ['The URL changed, but the previous main content is still displayed. WAIT for the replacement content; these controls are not yet valid for the new page.'] : []),
    ...(page.fields || []).map((f: any) => 'Field ' + f.name + ' = ' + String(f.value).slice(0, 1000) + (f.focused ? ' [focused]' : '')),
    ...browser.media.map(m => 'Media evidence: ' + JSON.stringify(m)),
    ...String(page.text || '').split('\n').filter(Boolean).slice(0, 60).map(line => 'Page text: ' + line),
  ];
  return { id: randomUUID(), capturedAt: Date.now(), context: { driver: 'browser', app, windowId: tab.tabId, surface: 'page' },
    applications, windows: tabs.map(t => ({ id: t.tabId, app, title: t.title, focused: t.active })),
    snapshots: [{ id, app, windowId: tab.tabId, windowTitle: page.title, complete: true, capturedAt: Date.now(),
      elements, text: [...evidence, ...lines].map(s => s.slice(0, 2000)).slice(0, 600), surface: 'page', browser }],
    notices: ['Browser content is controlled through agent-browser in its bound tab. Native menus and dialogs remain available through READ_SURFACE.',
      'Command delivery is not task completion. Search requires observed results; playing media requires paused=false and advancing=true.'],
  };
}
