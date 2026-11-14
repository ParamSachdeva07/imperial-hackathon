import { describe, expect, it, vi } from 'vitest';
import { browserResult, type BrowserClient } from '../apps/desktop/electron/browser/client';
import { browserObservation, type BrowserCapture } from '../apps/desktop/electron/browser/observation';
import { BrowserWorkspace } from '../apps/desktop/electron/browser/workspace';
import { browserCandidates } from '../apps/desktop/electron/browser/candidates';
import { PAGE_STATE, ACTIVE_HTML, PAGE_IDENTITY as IDENTITY } from '../apps/desktop/electron/browser/page-state';
import { NativeError } from '../apps/desktop/electron/desktop/native-client';
import { decisionPage } from '../apps/desktop/electron/controller/decision-context';
import {
  DesktopDecisionRequestSchema,
  TaskInputSchema,
  type DesktopCandidate,
  type DesktopObservation,
} from '../packages/contracts/src/index';

function capture(): BrowserCapture {
  return {
    snapshot: {
      snapshot: [
        '- textbox "Search" [ref=e20]',
        '- button "Find" [ref=e3]',
        '- link "Result" [ref=e41, url=https://example.test/result]',
      ].join('\n'),
      refs: {
        e3: { name: 'Find', role: 'button' },
        e20: { name: 'Search', role: 'textbox' },
        e41: { name: 'Result', role: 'link' },
      },
    },
    page: {
      url: 'https://example.test/',
      title: 'Search fixture',
      documentId: '1810000000000',
      readyState: 'complete',
      contentKey: 'initial-main-content',
      fields: [{ name: 'Search', value: '', focused: true }],
      media: [],
    },
    tabs: [
      { tabId: 't1', title: 'Search fixture', active: true },
      { tabId: 't2', title: 'Other observed page', active: false },
    ],
  };
}

class FakeBrowser implements BrowserClient {
  state = capture();
  calls: string[][] = [];
  failedReadback = false;
  fieldHtml = '<input id="query" aria-label="Search">';
  activeHtml = this.fieldHtml;
  beforeCommand?: (command: string[]) => void;

  async run(command: string[]): Promise<any> {
    this.calls.push([...command]);
    this.beforeCommand?.(command);
    const [operation, arg, target] = command;
    if (operation === 'open') return { url: arg };
    if (operation === 'snapshot') return structuredClone(this.state.snapshot);
    if (operation === 'tab' && arg === 'list') return { tabs: structuredClone(this.state.tabs) };
    if (operation === 'eval') {
      if (arg === '(' + IDENTITY + ')()') return { result: {
        url: this.state.page.url, documentId: this.state.page.documentId,
      } };
      if (arg === '(' + PAGE_STATE + ')()') return { result: structuredClone(this.state.page) };
      if (arg === '(' + ACTIVE_HTML + ')()') return { result: this.activeHtml };
      throw new Error('Unexpected observation script');
    }
    if (operation === 'get' && target !== '@e20') throw new Error('Unexpected field target');
    if (operation === 'get' && arg === 'value') return { value: this.state.page.fields[0].value };
    if (operation === 'get' && arg === 'html') return { html: this.fieldHtml };
    if (operation === 'fill') {
      if (!this.failedReadback) this.state.page.fields[0].value = command[2];
      return {};
    }
    if (operation === 'tab') {
      this.state.tabs.forEach(tab => { tab.active = tab.tabId === arg; });
      return {};
    }
    if (['focus', 'click', 'press', 'check', 'uncheck', 'scroll', 'back', 'forward'].includes(operation)) return {};
    throw new Error('Unexpected browser command: ' + command.join(' '));
  }
}

const task = TaskInputSchema.parse({ provider: 'jev', goal: 'Search this page for the supplied text.' });
const signal = () => new AbortController().signal;
const inputCommands = (client: FakeBrowser) => client.calls.filter(command =>
  ['fill', 'click', 'press', 'check', 'uncheck', 'scroll', 'open', 'tab'].includes(command[0]) &&
  !(command[0] === 'tab' && command[1] === 'list'));

function choice(observation: DesktopObservation, operation: DesktopCandidate['operation'], name?: string) {
  const result = browserCandidates(observation, task).find(candidate => candidate.operation === operation &&
    (!name || candidate.name === name));
  if (!result) throw new Error('Missing fixture choice: ' + operation);
  return result;
}

async function fixture() {
  const client = new FakeBrowser();
  const workspace = new BrowserWorkspace(client);
  const observation = await workspace.observe({ driver: 'browser', app: 'Google Chrome' }, []);
  client.calls = [];
  return { client, workspace, observation };
}

describe('agent-browser protocol and observations', () => {
  it('generates syntactically valid fixed page observation code', () => {
    expect(() => new Function('return (' + PAGE_STATE + ');')).not.toThrow();
  });

  it('decodes the real batch result envelope without treating payload as another envelope', () => {
    const payload = { url: 'https://example.test/', lifecycle: { reused: true } };
    expect(browserResult([{ index: 0, success: true, result: payload, error: null }])).toEqual(payload);
    expect(browserResult({ success: true, data: payload, error: null })).toEqual(payload);
    expect(() => browserResult([{ index: 0, success: false, result: null, error: 'Target covered' }]))
      .toThrow('Target covered');
  });

  it('preserves visible order while binding every ref to its observation', () => {
    const observation = browserObservation(capture(), 'Chrome fixture', []);
    const snapshot = observation.snapshots[0];
    expect(snapshot.elements.map(element => element.nativeId)).toEqual(['e20', 'e3', 'e41']);
    expect(snapshot.elements.map(element => element.ref)).toEqual(['e20', 'e3', 'e41'].map(ref => '@' + snapshot.id + ':' + ref));
    expect(snapshot.elements[0]).toMatchObject({ role: 'textfield', name: 'Search', states: ['focused'], actions: ['SetValue', 'SetFocus'] });
    expect(observation.context).toMatchObject({ driver: 'browser', windowId: 't1', surface: 'page' });
  });

  it('reads only actual state attributes rather than words inside accessible names', () => {
    const state = capture();
    state.snapshot.snapshot += '\n- button "Open disabled items" [ref=e50]\n- button "Unavailable" [disabled, ref=e51]';
    state.snapshot.refs.e50 = { name: 'Open disabled items', role: 'button' };
    state.snapshot.refs.e51 = { name: 'Unavailable', role: 'button' };
    const observation = browserObservation(state, 'Chrome fixture', []);
    expect(observation.snapshots[0].elements.find(element => element.nativeId === 'e50')?.states).not.toContain('disabled');
    expect(observation.snapshots[0].elements.find(element => element.nativeId === 'e51')?.states).toContain('disabled');
  });

  it('keeps media progression as measured evidence, not an inference from a Play button', () => {
    const state = capture();
    state.page.media = [{ kind: 'video', source: 'blob:test', paused: false, ended: false, time: 4.2, advancing: true }];
    const observation = browserObservation(state, 'Chrome fixture', []);
    expect(observation.snapshots[0].browser?.media[0].advancing).toBe(true);
    expect(observation.snapshots[0].text?.some(line => line.includes('"advancing":true'))).toBe(true);
  });

  it('does not expose native paste or caret-insertion tools to browser fields', () => {
    const observation = browserObservation(capture(), 'Chrome fixture', []);
    const candidates = browserCandidates(observation, task);
    expect(candidates.some(candidate => candidate.operation === 'SET_VALUE')).toBe(true);
    expect(candidates.some(candidate => ['FOCUS_AND_PASTE', 'TYPE'].includes(candidate.operation))).toBe(false);
  });

  it('accepts browser operations through the shared strict decision contract', () => {
    const observation = browserObservation(capture(), 'Chrome fixture', []);
    const candidates = browserCandidates(observation, task);
    const request = decisionPage(observation, candidates, task, 'b881c6b4-642d-426f-9113-3b28bdf10c3c', 1, 0, new Set([0]), []);
    expect(DesktopDecisionRequestSchema.parse(request).context.driver).toBe('browser');
    for (const operation of ['NAVIGATE', 'BACK', 'FORWARD', 'WAIT', 'READ_WINDOW'])
      expect(candidates.some(candidate => candidate.operation === operation)).toBe(true);
  });
});

describe('browser dispatch preconditions', () => {
  it.each(['document', 'url', 'tab'] as const)('re-observes a changed %s without dispatching input', async (changed) => {
    const { client, workspace, observation } = await fixture();
    if (changed === 'document') client.state.page.documentId = '1810000001000';
    if (changed === 'url') client.state.page.url = 'https://example.test/other';
    if (changed === 'tab') client.state.tabs.forEach(tab => { tab.active = tab.tabId === 't2'; });
    const result = workspace.act(choice(observation, 'CLICK', 'Find'), observation, undefined, signal());
    await expect(result).rejects.toMatchObject({ code: 'STALE_REF', disposition: { delivery: 'not_delivered', retry: 'safe' } });
    expect(inputCommands(client)).toEqual([]);
  });

  it.each(['removed', 'renamed', 'role'] as const)('rejects a %s target before dispatch', async (change) => {
    const { client, workspace, observation } = await fixture();
    if (change === 'removed') delete client.state.snapshot.refs.e3;
    if (change === 'renamed') client.state.snapshot.refs.e3.name = 'Delete';
    if (change === 'role') client.state.snapshot.refs.e3.role = 'link';
    await expect(workspace.act(choice(observation, 'CLICK', 'Find'), observation, undefined, signal())).rejects.toBeInstanceOf(NativeError);
    expect(inputCommands(client)).toEqual([]);
  });

  it.each(['app', 'window'] as const)('rejects candidate %s mismatches', async (scope) => {
    const { client, workspace, observation } = await fixture();
    const candidate = { ...choice(observation, 'CLICK', 'Find'), ...(scope === 'app' ? { app: 'Another app' } : { windowId: 't2' }) };
    await expect(workspace.act(candidate, observation, undefined, signal())).rejects.toThrow();
    expect(inputCommands(client)).toEqual([]);
  });

  it('rejects targets outside the bound snapshot', async () => {
    const { client, workspace, observation } = await fixture();
    const candidate = { ...choice(observation, 'CLICK', 'Find'), targetRef: '@another:e3' };
    await expect(workspace.act(candidate, observation, undefined, signal())).rejects.toThrow('outside');
    expect(inputCommands(client)).toEqual([]);
  });

  it('switches only to a tab included in the observation', async () => {
    const { client, workspace, observation } = await fixture();
    const observed = choice(observation, 'READ_WINDOW');
    await expect(workspace.act({ ...observed, windowId: 'unobserved' }, observation, undefined, signal())).rejects.toThrow('not observed');
    expect(inputCommands(client)).toEqual([]);
    const next = await workspace.act(observed, observation, undefined, signal());
    expect(next.windowId).toBe('t2');
    expect(inputCommands(client)).toEqual([['tab', 't2']]);
  });
});

describe('browser observation consistency', () => {
  const nextDocument = (client: FakeBrowser) => {
    client.state.page.documentId = String(Number(client.state.page.documentId) + 1);
    client.state.page.url = 'https://example.test/next';
    client.state.page.title = 'Next document';
    client.state.page.fields = [];
    client.state.snapshot = {
      snapshot: '- button "Next document action" [ref=e4]',
      refs: { e4: { name: 'Next document action', role: 'button' } },
    };
  };

  it.each(['snapshot', 'metadata'] as const)('discards a navigation occurring before %s and returns a coherent new observation', async (stage) => {
    const { client, workspace, observation } = await fixture();
    let changed = false;
    client.beforeCommand = command => {
      const atBoundary = stage === 'snapshot' ? command[0] === 'snapshot'
        : command[0] === 'eval' && command[1] === '(' + PAGE_STATE + ')()';
      if (atBoundary && !changed) { changed = true; nextDocument(client); }
    };
    const result = await workspace.observe(observation.context, []);
    expect(result.snapshots[0].browser).toMatchObject({ documentId: client.state.page.documentId, url: 'https://example.test/next' });
    expect(result.snapshots[0].elements.map(element => element.name)).toEqual(['Next document action']);
    expect(client.calls.filter(command => command[0] === 'snapshot')).toHaveLength(2);
    expect(inputCommands(client)).toEqual([]);
  });

  it('discards a tab switch after page metadata instead of binding old controls to the new tab', async () => {
    const { client, workspace, observation } = await fixture();
    let tabReads = 0;
    client.beforeCommand = command => {
      if (command[0] === 'tab' && command[1] === 'list' && ++tabReads === 2) {
        client.state.tabs.forEach(tab => { tab.active = tab.tabId === 't2'; });
        nextDocument(client);
      }
    };
    const result = await workspace.observe(observation.context, []);
    expect(result.context.windowId).toBe('t2');
    expect(result.snapshots[0].browser?.tabId).toBe('t2');
    expect(result.snapshots[0].elements.map(element => element.name)).toEqual(['Next document action']);
    expect(client.calls.filter(command => command[0] === 'snapshot')).toHaveLength(2);
    expect(inputCommands(client)).toEqual([]);
  });

  it('bounds repeated read instability and reports that no input was delivered', async () => {
    const { client, workspace, observation } = await fixture();
    client.beforeCommand = command => {
      if (command[0] === 'eval' && command[1] === '(' + PAGE_STATE + ')()') nextDocument(client);
    };
    await expect(workspace.observe(observation.context, [])).rejects.toMatchObject({
      code: 'STALE_REF', disposition: { delivery: 'not_delivered', retry: 'safe' },
    });
    expect(client.calls.filter(command => command[0] === 'snapshot')).toHaveLength(3);
    expect(inputCommands(client)).toEqual([]);
  });

  it('does not execute an old decision after its preflight read recovers onto another document', async () => {
    const { client, workspace, observation } = await fixture();
    let changed = false;
    client.beforeCommand = command => {
      if (!changed && command[0] === 'eval' && command[1] === '(' + PAGE_STATE + ')()') {
        changed = true;
        nextDocument(client);
      }
    };
    await expect(workspace.act(choice(observation, 'CLICK', 'Find'), observation, undefined, signal()))
      .rejects.toMatchObject({ code: 'STALE_REF', disposition: { delivery: 'not_delivered', retry: 'safe' } });
    expect(client.calls.filter(command => command[0] === 'snapshot')).toHaveLength(2);
    expect(inputCommands(client)).toEqual([]);
  });
});

describe('browser SPA content transitions', () => {
  async function startTransition() {
    const result = await fixture();
    await result.workspace.act(choice(result.observation, 'CLICK', 'Find'), result.observation, undefined, signal());
    result.client.state.page.url = 'https://example.test/results';
    result.client.calls = [];
    return result;
  }

  it('withholds old controls after a same-document URL change and never dispatches them', async () => {
    const { client, workspace, observation } = await startTransition();
    const pending = await workspace.observe(observation.context, []);
    expect(pending.snapshots[0].browser).toMatchObject({ url: 'https://example.test/results', contentPending: true });
    expect(client.calls.filter(command => command[0] === 'snapshot')).toHaveLength(3);
    expect(inputCommands(client)).toEqual([]);
    const candidates = browserCandidates(pending, task);
    expect(candidates.some(candidate => candidate.operation === 'WAIT')).toBe(true);
    expect(candidates.every(candidate => ['WAIT', 'READ_SURFACE', 'BROWSE_APPS', 'OPEN_APP'].includes(candidate.operation))).toBe(true);

    const staleControl = {
      ...choice(observation, 'CLICK', 'Find'),
      snapshotId: pending.snapshots[0].id,
      targetRef: pending.snapshots[0].elements.find(element => element.name === 'Find')!.ref,
    };
    client.calls = [];
    await expect(workspace.act(staleControl, pending, undefined, signal())).rejects.toMatchObject({
      code: 'STALE_REF', disposition: { delivery: 'not_delivered', retry: 'safe' },
    });
    expect(inputCommands(client)).toEqual([]);
  });

  it('enables replacement controls after the main content arrives, without replaying navigation', async () => {
    const { client, workspace, observation } = await startTransition();
    let snapshots = 0;
    client.beforeCommand = command => {
      if (command[0] === 'snapshot' && ++snapshots === 2) {
        client.state.page.contentKey = 'loaded-results';
        client.state.snapshot = {
          snapshot: '- link "New result" [ref=e60]',
          refs: { e60: { name: 'New result', role: 'link' } },
        };
      }
    };
    const loaded = await workspace.observe(observation.context, []);
    expect(loaded.snapshots[0].browser?.contentPending).toBe(false);
    expect(loaded.snapshots[0].elements.map(element => element.name)).toEqual(['New result']);
    expect(choice(loaded, 'CLICK', 'New result')).toBeDefined();
    expect(snapshots).toBe(2);
    expect(inputCommands(client)).toEqual([]);

    // Clearing the transition must be durable: a later observed URL update is
    // not still compared with the prior action's obsolete content baseline.
    client.beforeCommand = undefined;
    client.state.page.url = 'https://example.test/results#details';
    client.calls = [];
    const later = await workspace.observe(loaded.context, []);
    expect(later.snapshots[0].browser?.contentPending).toBe(false);
    expect(client.calls.filter(command => command[0] === 'snapshot')).toHaveLength(1);
  });

  it('accepts a new document even when its main text happens to match the old page', async () => {
    const { client, workspace, observation } = await startTransition();
    client.state.page.documentId = '1810000001000';
    const loaded = await workspace.observe(observation.context, []);
    expect(loaded.snapshots[0].browser).toMatchObject({ documentId: '1810000001000', contentPending: false });
    expect(choice(loaded, 'CLICK', 'Find')).toBeDefined();
    expect(client.calls.filter(command => command[0] === 'snapshot')).toHaveLength(1);
    expect(inputCommands(client)).toEqual([]);
  });

  it('stops an unresolved transition after its deadline without repeating the delivered action', async () => {
    const before = Date.now();
    const { client, workspace, observation } = await startTransition();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(before + 16_000);
    try {
      await expect(workspace.observe(observation.context, [])).rejects.toThrow('previous action will not be repeated');
      expect(client.calls.filter(command => command[0] === 'snapshot')).toHaveLength(1);
      expect(inputCommands(client)).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('browser text delivery', () => {
  it('replaces once with literal Unicode and metacharacters, then verifies the exact field', async () => {
    const { client, workspace, observation } = await fixture();
    const text = 'Café 😊 $HOME $(do-not-run) "quoted"';
    await workspace.act(choice(observation, 'SET_VALUE', 'Search'), observation, text, signal());
    expect(client.calls.filter(command => command[0] === 'fill')).toEqual([['fill', '@e20', text]]);
    expect(client.state.page.fields[0].value).toBe(text);
    expect(workspace.takeActionReport()).toMatchObject({ verification: 'verified', expectedValue: text, observedValue: text });
    expect(workspace.takeActionReport()).toBeUndefined();
  });

  it('recognizes an already satisfied value across new snapshots without duplicating it', async () => {
    const { client, workspace, observation } = await fixture();
    await workspace.act(choice(observation, 'SET_VALUE', 'Search'), observation, 'rag', signal());
    const after = await workspace.observe(observation.context, []);
    expect(after.snapshots[0].id).not.toBe(observation.snapshots[0].id);
    client.calls = [];
    await workspace.act(choice(after, 'SET_VALUE', 'Search'), after, 'rag', signal());
    expect(client.calls.some(command => ['fill', 'focus'].includes(command[0]))).toBe(false);
    expect(client.state.page.fields[0].value).toBe('rag');
    expect(workspace.takeActionReport()).toMatchObject({ delivery: 'not_delivered', verification: 'already_satisfied' });
  });

  it('preserves an intervening user edit instead of overwriting it', async () => {
    const { client, workspace, observation } = await fixture();
    client.state.page.fields[0].value = 'user change';
    await expect(workspace.act(choice(observation, 'SET_VALUE', 'Search'), observation, 'rag', signal()))
      .rejects.toMatchObject({ code: 'STALE_REF', disposition: { delivery: 'not_delivered', retry: 'safe' } });
    expect(client.calls.some(command => ['fill', 'focus'].includes(command[0]))).toBe(false);
    expect(client.state.page.fields[0].value).toBe('user change');
  });

  it('stops on uncertain readback and never repeats the fill', async () => {
    const { client, workspace, observation } = await fixture();
    client.failedReadback = true;
    await expect(workspace.act(choice(observation, 'SET_VALUE', 'Search'), observation, 'rag', signal()))
      .rejects.toThrow('will not be repeated');
    expect(client.calls.filter(command => command[0] === 'fill')).toEqual([['fill', '@e20', 'rag']]);
    expect(workspace.takeActionReport()).toBeUndefined();
  });

  it('does not type when the active editor differs from an available outerHTML target', async () => {
    const { client, workspace, observation } = await fixture();
    client.activeHtml = '<input id="other">';
    await expect(workspace.act(choice(observation, 'SET_VALUE', 'Search'), observation, 'rag', signal())).rejects.toThrow('focus');
    expect(client.calls.some(command => command[0] === 'fill')).toBe(false);
  });

  it('forwards the supplied domain literally, without synthesizing a URL', async () => {
    const { client, workspace, observation } = await fixture();
    await workspace.act(choice(observation, 'NAVIGATE'), observation, 'example.test', signal());
    expect(inputCommands(client)).toEqual([['open', 'example.test']]);
  });

  it.each(['javascript:alert(1)', 'file:///private/document', 'not a URL'])('rejects unsupported navigation input %s', async (text) => {
    const { client, workspace, observation } = await fixture();
    await expect(workspace.act(choice(observation, 'NAVIGATE'), observation, text, signal())).rejects.toThrow('HTTP');
    expect(inputCommands(client)).toEqual([]);
  });
});
