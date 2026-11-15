import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PAGE_BRIDGE_EXTENSION_ID, PAGE_BRIDGE_VERSION } from '../apps/desktop/electron/page/extension-id';
import { PageBridgeServer } from '../apps/desktop/electron/page/page-bridge-server';
import { PageUnavailable, PageWorkspace } from '../apps/desktop/electron/page/page-workspace';
import { PageAwareBridge } from '../apps/desktop/electron/page/page-aware-bridge';
import { validatedUrl, type WorkspaceBridge } from '../apps/desktop/electron/desktop/workspace';
import { ObservationIndex } from '../apps/desktop/electron/controller/v2/observation-index';
import { PlannerLoop, V2_LIMITS, type PlannerHost } from '../apps/desktop/electron/controller/v2/planner-loop';
import type { DecisionProvider } from '../apps/desktop/electron/services/decision-client';
import { TaskInputSchema, type ControllerState, type DesktopContext, type DesktopObservation, type PlanRequest, type PlanStep } from '../packages/contracts/src/index';

beforeAll(() => { V2_LIMITS.settleIntervalMs = 1; V2_LIMITS.settleCapMs = 30; });
const ORIGIN = 'chrome-extension://' + PAGE_BRIDGE_EXTENSION_ID;
const servers: PageBridgeServer[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(); });

/** A stand-in for the extension: asks for commands the way the real worker does and answers from `page`. */
async function start(handler: (command: any) => unknown, holdMs = 300, version = PAGE_BRIDGE_VERSION) {
  const server = new PageBridgeServer(0, ORIGIN, holdMs);
  servers.push(server);
  expect(await server.start()).toBe(true);
  const post = (path: string, body: unknown, origin = ORIGIN) => fetch('http://127.0.0.1:' + server.port + path,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  let stopped = false;
  const commands: any[] = [];
  const loop = (async () => {
    while (!stopped) {
      const command: any = await post('/bridge/poll', { version }).then(r => r.json()).catch(() => undefined);
      if (!command?.id) continue;
      commands.push(command);
      let result;
      try { result = { ok: true, data: await handler(command) }; } catch (error) { result = { ok: false, error: (error as Error).message }; }
      await post('/bridge/result', { id: command.id, ...result }).catch(() => undefined);
    }
  })();
  await new Promise(resolve => setTimeout(resolve, 30));
  return { server, post, commands, stop: async () => { stopped = true; server.stop(); await loop; } };
}
const pageReply = (over: Record<string, unknown> = {}) => ({
  tab: { id: 7, url: 'https://example.test/search', title: 'Search - Example', status: 'complete' },
  tabs: [{ id: 7, title: 'Search - Example', url: 'https://example.test/search', active: true }, { id: 8, title: 'Inbox', url: 'https://mail.test', active: false }],
  page: { document: 'doc1', url: 'https://example.test/search', title: 'Search - Example', readyState: 'complete', count: 5, truncated: false, frames: 0, ms: 3,
    nodes: { id: 0, role: 'webarea', name: 'Search - Example', value: 'https://example.test/search', children: [
      { id: 1, role: 'form', name: 'Site search', actions: [], states: [], children: [
        { id: 2, role: 'searchfield', name: 'Search the site', value: '', states: ['focused'], actions: ['SetValue', 'TypeText', 'SetFocus', 'ScrollTo'], bounds: { x: 10, y: 10, width: 300, height: 30 } },
        { id: 3, role: 'button', name: 'Search', actions: ['Click', 'SetFocus', 'ScrollTo'], states: [], bounds: { x: 320, y: 10, width: 80, height: 30 } }] },
      { id: 4, role: 'heading', name: 'Results', actions: ['ScrollTo'], states: [] },
      { id: 5, role: 'statictext', name: '12 results for desks', actions: [], states: [] }] } }, ...over });

describe('page bridge server', () => {
  it('answers only the pinned extension, and only POST', async () => {
    const bridge = await start(() => ({}));
    expect((await bridge.post('/bridge/poll', {}, 'https://evil.example')).status).toBe(403);
    expect((await bridge.post('/bridge/poll', {}, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(403);
    expect((await fetch('http://127.0.0.1:' + bridge.server.port + '/bridge/poll', { headers: { Origin: ORIGIN } })).status).toBe(403);
    await bridge.stop();
  });
  it('derives the pinned id from the key in the extension manifest', () => {
    const key = Buffer.from(JSON.parse(readFileSync('extension/page-bridge/manifest.json', 'utf8')).key, 'base64');
    const id = [...createHash('sha256').update(key).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
    expect(id).toBe(PAGE_BRIDGE_EXTENSION_ID);
  });
  it('hands a command to the waiting extension at once and returns its result', async () => {
    const bridge = await start(command => ({ echoed: command.type, value: command.value }));
    expect(bridge.server.connected).toBe(true);
    const started = Date.now();
    expect(await bridge.server.send('ping', { value: 5 })).toEqual({ echoed: 'ping', value: 5 });
    expect(Date.now() - started).toBeLessThan(200);
    // A second command right after the first is picked up by the next poll.
    expect(await bridge.server.send('ping', { value: 6 })).toEqual({ echoed: 'ping', value: 6 });
    await bridge.stop();
  });
  it('reports an extension error, a timeout, and a missing extension as failures', async () => {
    const bridge = await start(command => { if (command.type === 'boom') throw new Error('no such tab'); return new Promise(resolve => setTimeout(resolve, 150)); });
    await expect(bridge.server.send('boom')).rejects.toThrow('no such tab');
    await expect(bridge.server.send('slow', {}, 60)).rejects.toThrow('did not answer in time');
    await bridge.stop();
    const alone = new PageBridgeServer(0, ORIGIN, 50);
    servers.push(alone);
    await alone.start();
    expect(alone.connected).toBe(false);
    await expect(alone.send('ping')).rejects.toThrow('not connected');
  });
});

describe('page workspace', () => {
  it('turns the page into an observation the index can use, without native-only operations', async () => {
    const bridge = await start(() => pageReply());
    const observation = await new PageWorkspace(bridge.server).observe('Google Chrome', [{ name: 'Notes', id: 'notes', running: true }]);
    expect(observation.context).toEqual({ driver: 'browser', app: 'Google Chrome' });
    expect(observation.snapshots[0]).toMatchObject({ surface: 'page', windowTitle: 'Search - Example', complete: true });
    expect(observation.notices.join(' ')).toContain('Page address: https://example.test/search');
    expect(observation.notices.join(' ')).toContain('"Inbox"');
    const index = new ObservationIndex(observation);
    const selection = index.select({ query: 'search', requirementTerms: [], pinned: [] });
    const field = selection.elements.find(e => e.label === 'Search the site')!;
    // Already focused, so FOCUS is not offered; clipboard paste is a native operation and is not offered on a page.
    expect(field.operations).toEqual(['SET_VALUE', 'TYPE', 'SCROLL_TO']);
    expect(field.path).toBe('Search - Example > Site search');
    expect(selection.elements.find(e => e.label === 'Search')?.operations).toEqual(['CLICK', 'FOCUS', 'SCROLL_TO']);
    expect(index.select({ query: 'results desks', requirementTerms: [], pinned: [] }).elements.some(e => e.label === '12 results for desks')).toBe(true);
    // From the page, the browser's own window is one read away; from the window, so is the page.
    expect(selection.scopes.map(s => s.id)).toEqual(expect.arrayContaining(['surface:window', 'surface:menubar', 'apps']));
    expect(selection.scopes.map(s => s.id)).not.toContain('surface:sheet');
    await bridge.stop();
  });
  it('sends one operation to the page and reports what was read back', async () => {
    const bridge = await start(command => command.type === 'snapshot' ? pageReply()
      : command.operation === 'setValue' ? { dispatched: true, observedValue: command.argument }
      : command.operation === 'type' ? { dispatched: true, expectedValue: 'old-' + command.argument, observedValue: 'old-new' }
      : command.operation === 'click' ? { dispatched: true }
      : command.operation === 'check' ? { dispatched: true, verified: false }
      : command.operation === 'uncheck' ? { dispatched: false, already: true, verified: true }
      : command.operation === 'press' ? { dispatched: false, code: 'FOCUS_MOVED', message: 'Keyboard focus is no longer on that field.' }
      : { dispatched: false, code: 'STALE', message: 'That element is no longer on the page.' });
    const page = new PageWorkspace(bridge.server);
    const observation = await page.observe('Google Chrome', []);
    const snapshot = observation.snapshots[0];
    const candidate = (operation: any, label: string, extra = {}) => { const element = snapshot.elements.find(e => e.name === label)!;
      return { id: 'x', operation, description: '', name: label, app: 'Google Chrome', snapshotId: snapshot.id, targetRef: element.ref, ...extra }; };
    const signal = new AbortController().signal;
    expect(await page.act(candidate('SET_VALUE', 'Search the site'), observation, 'desks', signal)).toEqual({ driver: 'browser', app: 'Google Chrome' });
    expect(bridge.commands.at(-1)).toMatchObject({ type: 'act', tabId: 7, document: 'doc1', element: 2, operation: 'setValue', argument: 'desks' });
    await expect(bridge.server.send('act', { id: 2 })).rejects.toThrow('reserved names');
    expect(page.takeActionReport()).toMatchObject({ delivery: 'delivered', verification: 'verified', observedValue: 'desks' });
    await page.act(candidate('TYPE', 'Search the site'), observation, 'new', signal);
    expect(page.takeActionReport()).toMatchObject({ verification: 'verified', expectedValue: 'old-new', observedValue: 'old-new' });
    await page.act(candidate('TYPE', 'Search the site'), observation, 'transformed', signal);
    expect(page.takeActionReport()).toMatchObject({ delivery: 'delivered', verification: 'unverified', expectedValue: 'old-transformed' });
    await page.act(candidate('CLICK', 'Search'), observation, undefined, signal);
    expect(page.takeActionReport()).toMatchObject({ verification: 'unverified' });
    await expect(page.act(candidate('SCROLL_TO', 'Results'), observation, undefined, signal)).rejects.toMatchObject({ code: 'STALE', disposition: { delivery: 'not_delivered' } });
    // A click that was sent but whose effect is not visible yet is delivered, not "nothing sent".
    await page.act(candidate('CHECK', 'Search'), observation, undefined, signal);
    expect(page.takeActionReport()).toMatchObject({ delivery: 'delivered', verification: 'unverified' });
    await page.act(candidate('UNCHECK', 'Search'), observation, undefined, signal);
    expect(page.takeActionReport()).toMatchObject({ delivery: 'not_delivered', verification: 'already_satisfied' });
    // Return names its field; the page refuses when focus has moved, and nothing is sent.
    await expect(page.act(candidate('PRESS', 'Search the site', { key: 'return' }), observation, undefined, signal))
      .rejects.toMatchObject({ code: 'FOCUS_MOVED', disposition: { delivery: 'not_delivered' } });
    expect(bridge.commands.at(-1)).toMatchObject({ operation: 'press', element: 2, requireFocus: true });
    await expect(page.act({ id: 'x', operation: 'PRESS', description: '', name: 'return', app: 'Google Chrome', snapshotId: snapshot.id, key: 'return' } as any,
      observation, undefined, signal)).rejects.toThrow('needs the field');
    await expect(page.act(candidate('FOCUS_AND_PASTE', 'Search the site'), observation, 'x', signal)).rejects.toThrow('not available on a web page');
    await expect(page.act(candidate('PRESS', 'Search', { key: 'cmd+w' }), observation, undefined, signal)).rejects.toThrow('key is not available');
    await bridge.stop();
  });
  it('refuses a tab it cannot read, so the caller falls back to accessibility', async () => {
    const bridge = await start(() => ({ tab: { id: 1, url: 'chrome://newtab/', title: 'New Tab' }, restricted: true }));
    await expect(new PageWorkspace(bridge.server).observe('Google Chrome', [])).rejects.toBeInstanceOf(PageUnavailable);
    await bridge.stop();
  });
});

class Native implements WorkspaceBridge {
  observed: DesktopContext[] = []; acts: string[] = []; opened: string[] = [];
  applications = async () => [{ name: 'Google Chrome', id: 'com.google.Chrome', running: true }];
  async observe(context: DesktopContext): Promise<DesktopObservation> {
    this.observed.push(context);
    return { id: 'n' + this.observed.length, capturedAt: 1, applications: await this.applications(), notices: [],
      windows: context.app ? [{ id: 'w1', title: 'Chrome', app: context.app, focused: true }] : [],
      context: context.app ? { ...context, windowId: 'w1', surface: context.surface || 'window' } : {},
      snapshots: context.app ? [{ id: 's1', app: context.app, windowId: 'w1', windowTitle: 'Chrome', surface: context.surface || 'window', complete: true, capturedAt: 1, elements: [] }] : [] };
  }
  async act(candidate: any, observation: DesktopObservation) { this.acts.push(candidate.operation); return candidate.operation === 'OPEN_APP' ? { app: 'Google Chrome', windowId: 'w1' } : observation.context; }
  async openUrl(url: string) { this.opened.push(url); return { app: 'Google Chrome' }; }
  async probe() { return { states: ['focused'] }; }
}

describe('routing between the page and accessibility', () => {
  it('reads a Chrome tab through the extension and everything else natively', async () => {
    const bridge = await start(() => pageReply());
    const native = new Native();
    const aware = new PageAwareBridge(native, new PageWorkspace(bridge.server), async () => 'com.google.chrome', async () => undefined);
    expect((await aware.observe({ app: 'Google Chrome', windowId: 'w1' })).context.driver).toBe('browser');
    // An explicit surface means the browser's own window, and offers the way back to the page.
    const windowView = await aware.observe({ app: 'Google Chrome', windowId: 'w1', surface: 'window' });
    expect(windowView.context.driver).toBeUndefined();
    expect(windowView.pageBridge).toBe(true);
    expect(new ObservationIndex(windowView).select({ query: '', requirementTerms: [], pinned: [] }).scopes[0].id).toBe('page');
    expect((await aware.observe({ app: 'Notes' })).pageBridge).toBeUndefined();
    expect((await aware.observe({ driver: 'browser', app: 'Google Chrome' })).snapshots[0].surface).toBe('page');
    expect(native.observed.every(context => !('driver' in context))).toBe(true);
    await bridge.stop();
  });
  it('falls back to accessibility for a tab the extension cannot read, or when it is absent', async () => {
    const bridge = await start(() => ({ tab: { id: 1, url: 'chrome://settings/', title: 'Settings' }, restricted: true }));
    const native = new Native();
    const aware = new PageAwareBridge(native, new PageWorkspace(bridge.server));
    expect((await aware.observe({ app: 'Google Chrome' })).snapshots[0].surface).toBe('window');
    await bridge.stop();
    const absent = new PageBridgeServer(0, ORIGIN, 50);
    servers.push(absent);
    await absent.start();
    const plain = new PageAwareBridge(new Native(), new PageWorkspace(absent));
    const observation = await plain.observe({ app: 'Google Chrome' });
    expect(observation.snapshots[0].surface).toBe('window');
    expect(observation.pageBridge).toBeUndefined();
  });
  it('opens an address through the extension only when Chrome is the default browser', async () => {
    const bridge = await start(command => command.type === 'open_url' ? { tab: { id: 9, url: command.url, title: 'Opened' } } : pageReply());
    const native = new Native();
    const signal = new AbortController().signal;
    const activated: string[] = [];
    const chrome = new PageAwareBridge(native, new PageWorkspace(bridge.server), async () => 'com.google.Chrome', async bundle => activated.push(bundle));
    expect(await chrome.openUrl('https://example.test/', signal)).toEqual({ driver: 'browser', app: 'Google Chrome' });
    expect(bridge.commands.at(-1)).toMatchObject({ type: 'open_url', url: 'https://example.test/', newTab: true });
    expect(activated).toEqual(['com.google.chrome']);
    const safari = new PageAwareBridge(native, new PageWorkspace(bridge.server), async () => 'com.apple.Safari');
    await safari.openUrl('https://example.test/', signal);
    expect(native.opened).toEqual(['https://example.test/']);
    await bridge.stop();
  });
});

describe('opening an address', () => {
  it('refuses invented homepages and deep links but allows the exact user-supplied URL', async () => {
    const native = new Native();
    const opened: string[] = [];
    native.openUrl = async (url: string) => { opened.push(url); return { app: 'Google Chrome' }; };
    const requests: PlanRequest[] = [];
    const provider: DecisionProvider = { decide: async () => { throw new Error('unused'); }, plan: async request => {
      requests.push(request);
      const base = { taskId: request.taskId, observationId: request.observationId, model: 'scripted',
        requirements: [{ id: 'r1', text: 'Offers are shown', irreversible: false, kind: 'outcome' as const }], reconciliations: [], statuses: [],
        requirementId: 'r1', operation: 'OPEN_URL', target: '', targetDescription: '', text: '', textIsLiteral: false, key: '', direction: '',
        risk: 'reversible', repeat: false, expect: '', query: '', scope: '', waitMs: 0, message: '' };
      const urls = ['https://shop.test/offers/chicken', 'https://shop.test/', 'https://given.test/a/b'];
      return (requests.length <= 3 ? { ...base, kind: 'act', text: urls[requests.length - 1] } : { ...base, kind: 'blocked', operation: '', message: 'stop' }) as PlanStep;
    } };
    const state: ControllerState = { taskId: '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe', status: 'idle', busy: true, document: null, snapshot: null,
      decision: null, step: 0, verifiedText: null, events: [], input: TaskInputSchema.parse({ provider: 'jev', goal: 'See offers, also check https://given.test/a/b', controller: 'v2', maxSteps: 10 }) };
    await new PlannerLoop(native, provider).advance({ state, status: () => {}, event: () => {} }, false, new AbortController().signal);
    expect(requests[1].issues.join(' ')).toContain('neither supplied by the user nor observed');
    expect(opened).toEqual(['https://given.test/a/b']);
  });
  it('accepts only ordinary web addresses', () => {
    expect(validatedUrl(' https://en.wikipedia.org ')).toBe('https://en.wikipedia.org/');
    for (const bad of ['wikipedia.org', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.test/', 'x-apple.systempreferences:com.apple.preference'])
      expect(() => validatedUrl(bad), bad).toThrow();
  });
  it('runs a whole task on a page: open the address, fill the field, click, cite the result', async () => {
    let query = '', submitted = false;
    const reply = () => { const base = pageReply(); const field: any = base.page.nodes.children[0].children![0];
      field.value = query;
      base.page.nodes.children[2].name = submitted ? '3 results for ' + query : 'Type a search';
      if (submitted) { base.page.title = query + ' - Example'; base.page.nodes.name = query + ' - Example'; base.tab.title = query + ' - Example'; }
      return base; };
    const bridge = await start(command => {
      if (command.type === 'snapshot') return reply();
      if (command.type === 'open_url') return { tab: { id: 7, url: command.url, title: 'Search - Example' } };
      if (command.operation === 'setValue') { query = command.argument; return { dispatched: true, observedValue: query }; }
      if (command.operation === 'click') { submitted = true; return { dispatched: true }; }
      return { dispatched: false, message: 'unexpected' };
    });
    const native = new Native();
    const aware = new PageAwareBridge(native, new PageWorkspace(bridge.server), async () => 'com.google.chrome', async () => undefined);
    const requests: PlanRequest[] = [];
    const find = (request: PlanRequest, label: string) => request.elements.find(e => e.label.includes(label))!.id;
    const provider: DecisionProvider = { decide: async () => { throw new Error('unused'); }, plan: async request => {
      requests.push(structuredClone(request));
      const base = { taskId: request.taskId, observationId: request.observationId, model: 'scripted',
        requirements: [{ id: 'r1', text: 'Search results for desks are shown', irreversible: false, kind: 'outcome' as const }], reconciliations: [], statuses: [],
        requirementId: 'r1', operation: '', target: '', targetDescription: '', text: '', textIsLiteral: false, key: '', direction: '',
        risk: 'reversible', repeat: false, expect: '', query: '', scope: '', waitMs: 0, message: '' };
      const n = requests.length;
      return (n === 1 ? { ...base, kind: 'act', operation: 'OPEN_URL', text: 'https://example.test/' }
        : n === 2 ? { ...base, kind: 'act', operation: 'SET_VALUE', target: find(request, 'Search the site'), text: 'desks', textIsLiteral: true, reconciliations: [{ effectId: 'fx1', outcome: 'confirmed', evidence: [find(request, 'Search the site')] }] }
        : n === 3 ? { ...base, kind: 'act', operation: 'CLICK', target: request.elements.find(e => e.label === 'Search')!.id }
        : { ...base, kind: 'finish', statuses: [{ requirementId: 'r1', status: 'evidenced', evidence: [find(request, '3 results for desks')], checks: [] }] }) as PlanStep;
    } };
    const state: ControllerState = { taskId: '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe', status: 'idle', busy: true, document: null, snapshot: null,
      decision: null, step: 0, verifiedText: null, events: [], input: TaskInputSchema.parse({ provider: 'jev', goal: 'Search https://example.test/ for desks', controller: 'v2', maxSteps: 12 }) };
    const host: PlannerHost = { state, status: status => { state.status = status; }, event: () => {} };
    await new PlannerLoop(aware, provider).advance(host, false, new AbortController().signal);
    expect(state.status).toBe('completed');
    expect(bridge.commands.filter(c => c.type !== 'snapshot').map(c => c.operation || c.type)).toEqual(['open_url', 'setValue', 'click']);
    expect(native.acts).toEqual([]);
    expect(requests[1].observation.surface).toBe('page');
    expect(requests[1].allowedKeys).toEqual(['return', 'escape']);
    // The field it typed into is tagged as changed but was not what proved the result.
    expect(state.requirements?.[0].status).toBe('evidenced');
    await bridge.stop();
  });
});

describe('what a failure proves', () => {
  it('treats a lost reply as unknown, never as nothing sent', async () => {
    // The extension performs the command but its answer arrives too late.
    let opened = 0;
    const bridge = await start(command => { if (command.type === 'open_url') { opened++; return new Promise(resolve => setTimeout(resolve, 300)); } return pageReply(); });
    const page = new PageWorkspace(bridge.server);
    const original = (PageWorkspace.prototype as any).command;
    (page as any).command = function (this: any, type: string, payload: any, _timeout: number, signal?: AbortSignal) { return original.call(this, type, payload, 60, signal); };
    await expect(page.openUrl('https://example.test/', 'Google Chrome', new AbortController().signal))
      .rejects.toMatchObject({ disposition: { delivery: 'unknown' } });
    expect(opened).toBe(1);
    await bridge.stop();
    const absent = new PageBridgeServer(0, ORIGIN, 50);
    servers.push(absent);
    await absent.start();
    await expect(new PageWorkspace(absent).openUrl('https://example.test/', 'Google Chrome', new AbortController().signal))
      .rejects.toMatchObject({ disposition: { delivery: 'not_delivered' } });
  });
  it('gives the same-looking button on two pages two identities', async () => {
    let document = 'docA';
    const bridge = await start(() => pageReply({ page: { ...pageReply().page, document } }));
    const page = new PageWorkspace(bridge.server);
    const first = new ObservationIndex(await page.observe('Google Chrome', []));
    document = 'docB';
    const second = new ObservationIndex(await page.observe('Google Chrome', []));
    const button = (index: ObservationIndex) => index.nodes.find(n => n.label === 'Search')!;
    expect(second.find(button(first).identity, 'strong')).toEqual([]);
    expect(second.find(button(second).identity, 'exact')).toEqual([button(second)]);
    await bridge.stop();
  });
});

describe('an extension that was not reloaded', () => {
  it('is not used: its answers are in an older shape and would be misread', async () => {
    const bridge = await start(() => pageReply(), 300, '0.1.0');
    expect(bridge.server.reachable).toBe(true);
    expect(bridge.server.connected).toBe(false);
    expect(bridge.server.needsReload).toBe(true);
    const aware = new PageAwareBridge(new Native(), new PageWorkspace(bridge.server));
    expect((await aware.observe({ app: 'Google Chrome' })).snapshots[0].surface).toBe('window');
    expect(JSON.parse(readFileSync('extension/page-bridge/manifest.json', 'utf8')).version).toBe(PAGE_BRIDGE_VERSION);
    await bridge.stop();
  });
});
