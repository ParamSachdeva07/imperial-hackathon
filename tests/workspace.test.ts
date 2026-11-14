import { NATIVE_READ_NODE_BUDGET } from '../apps/desktop/electron/desktop/tree-budget';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceDesktopBridge } from '../apps/desktop/electron/desktop/workspace';
import type { DesktopCandidate, DesktopObservation } from '../packages/contracts/src/index';
import { rankApplicationPaths } from '../apps/desktop/electron/desktop/app-discovery';
import { NativeError } from '../apps/desktop/electron/desktop/native-client';
import { desktopCandidates } from '../apps/desktop/electron/controller/desktop-candidates';
import { TaskInputSchema } from '../packages/contracts/src/index';
const dirs: string[] = [];
class StubNative extends WorkspaceDesktopBridge {
  calls: { args: string[]; input?: string }[] = [];
  value = '';
  focused = true;
  popup = false;
  actionResult: any = {};
  constructor() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'assistant-bridge-test-'));
    super('unused', dir);
    dirs.push(dir);
  }
  protected async searchApplications(query: string) {
    return query === 'Hidden App' ? [{ name: 'Hidden App', id: 'com.example.hidden', running: false }] : [];
  }
  protected async run(args: string[], input?: string) {
    this.calls.push({ args, input });
    if (args[0] === 'get') return this.value;
    if (args[0] === 'list-windows')
      return [
        { id: 'w1', is_focused: this.focused },
        ...(this.popup ? [{ id: 'suggestion-popup', is_focused: false, accessible: true }] : []),
      ];
    if (args[0] === 'set-value') this.value = input || '';
    if (['click', 'press', 'set-value'].includes(args[0])) return this.actionResult;
    return {};
  }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const observation: DesktopObservation = {
  id: 'obs',
  capturedAt: 0,
  context: { app: 'Example', windowId: 'w1', surface: 'window' },
  applications: [],
  windows: [{ id: 'w1', app: 'Example', title: '', focused: true }],
  notices: [],
  snapshots: [
    {
      id: 's1',
      app: 'Example',
      windowId: 'w1',
      windowTitle: '',
      capturedAt: 0,
      complete: true,
      elements: [
        {
          ref: '@s1:e1',
          role: 'textfield',
          name: 'Body',
          value: '',
          actions: ['SetValue', 'Click'],
          states: [],
        },
      ],
    },
  ],
};
const candidate: DesktopCandidate = {
  id: 'write',
  operation: 'SET_VALUE',
  app: 'Example',
  windowId: 'w1',
  snapshotId: 's1',
  targetRef: '@s1:e1',
  name: 'Body',
  description: 'Write exact input',
};
describe('General native dispatch', () => {
  it('drills a native region without incompatible surface arguments', async () => {
    const bridge = new StubNative();
    await bridge.observe({ app: 'Example', windowId: 'w1', surface: 'window', rootRef: '@s1:e1' });
    const args = bridge.calls.find((c) => c.args[0] === 'snapshot')!.args;
    expect(args).toContain('--root');
    expect(args).not.toContain('--surface');
    expect(args).not.toContain('--window-id');
  });
  it('finds nested installations and offers observed results before launching', async () => {
    expect(
      rankApplicationPaths(['/Applications/Tools/Hidden App.app', '/Applications/Other.app'], 'Hidden App'),
    ).toEqual(['/Applications/Tools/Hidden App.app']);
    const bridge = new StubNative();
    const context = await bridge.act(
      { ...candidate, operation: 'SEARCH_APPS' },
      observation,
      'Hidden App',
      false,
      new AbortController().signal,
    );
    expect(bridge.calls).toHaveLength(0);
    const found = await bridge.observe(context);
    expect(found.applications).toEqual([{ name: 'Hidden App', id: 'com.example.hidden', running: false }]);
    await bridge.act(
      { ...candidate, operation: 'OPEN_APP', app: 'com.example.hidden' },
      found,
      undefined,
      false,
      new AbortController().signal,
    );
    expect(bridge.calls.some((c) => c.args[0] === 'launch' && c.args[1] === 'com.example.hidden')).toBe(true);
  });
  it('does not invent a launch target when an indexed search has no results', async () => {
    const bridge = new StubNative();
    const context = await bridge.act(
      { ...candidate, operation: 'SEARCH_APPS' },
      observation,
      'Unknown app',
      false,
      new AbortController().signal,
    );
    const found = await bridge.observe(context);
    expect(found.applications).toEqual([]);
    await expect(
      bridge.act(
        { ...candidate, operation: 'OPEN_APP', app: 'Unknown app' },
        found,
        undefined,
        false,
        new AbortController().signal,
      ),
    ).rejects.toThrow('inventory');
    expect(bridge.calls.some((c) => c.args[0] === 'launch')).toBe(false);
  });
  it('keeps text out of command arguments and passes it literally over stdin', async () => {
    const bridge = new StubNative(),
      text = 'Hello $HOME $(do-not-run)';
    await bridge.act(candidate, observation, text, false, new AbortController().signal);
    expect(bridge.calls.find((c) => c.args[0] === 'set-value')).toEqual({
      args: ['set-value', '@s1:e1', '--stdin'],
      input: text,
    });
  });
  it('stops before replacing an intervening user edit', async () => {
    const bridge = new StubNative();
    bridge.value = 'User edit';
    await expect(
      bridge.act(candidate, observation, 'replace', false, new AbortController().signal),
    ).rejects.toThrow('changed');
    expect(bridge.calls.some((c) => c.args[0] === 'set-value')).toBe(false);
  });
  it('rejects keyboard input when its selected window lost focus', async () => {
    const bridge = new StubNative();
    bridge.focused = false;
    await expect(
      bridge.act(
        { ...candidate, operation: 'PRESS', key: 'return' },
        observation,
        undefined,
        false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'STALE_REF',
      message: expect.stringContaining('lost focus'),
      disposition: { delivery: 'not_delivered', retry: 'safe' },
    });
    expect(bridge.calls.some((c) => c.args[0] === 'press')).toBe(false);
  });
  it('reads a newly appeared accessible suggestion window after text entry without focusing it', async () => {
    const bridge = new StubNative();
    bridge.popup = true;
    const context = await bridge.act(candidate, observation, 'hello', false, new AbortController().signal);
    expect(context).toEqual({ app: 'Example', windowId: 'suggestion-popup', surface: 'window' });
    expect(bridge.calls.some((c) => c.args[0] === 'focus-window' || c.args[0] === 'press')).toBe(false);
  });
  it('reads an observed window without sending desktop input', async () => {
    const bridge = new StubNative();
    const context = await bridge.act(
      { ...candidate, operation: 'READ_WINDOW' },
      observation,
      undefined,
      false,
      new AbortController().signal,
    );
    expect(context.windowId).toBe('w1');
    expect(bridge.calls).toHaveLength(0);
  });
  it('keeps the selected window when an autocomplete popup appears', async () => {
    const bridge = new StubNative();
    bridge.popup = true;
    const context = await bridge.act(
      { ...candidate, operation: 'PRESS', key: 'cmd+l' },
      observation,
      undefined,
      false,
      new AbortController().signal,
    );
    expect(context.windowId).toBe('w1');
  });
  it.each(['CLICK', 'PRESS'] as const)(
    'follows an action-reported overlay and drops the previous scope: %s',
    async (operation) => {
      const bridge = new StubNative();
      bridge.actionResult = { surfaces: [{ kind: 'menu' }] };
      const scoped = {
        ...observation,
        context: {
          ...observation.context,
          rootRef: '@s1:parent',
          scopePath: [{ ref: '@s1:parent', name: 'Toolbar' }],
        },
      };
      const context = await bridge.act(
        { ...candidate, operation, key: 'space' },
        scoped,
        undefined,
        false,
        new AbortController().signal,
      );
      expect(context).toEqual({ app: 'Example', windowId: 'w1', surface: 'menu' });
    },
  );
  it('never enables physical input as an automatic fallback', async () => {
    const bridge = new StubNative();
    await expect(
      bridge.act(
        { ...candidate, operation: 'DOUBLE_CLICK' },
        observation,
        undefined,
        false,
        new AbortController().signal,
      ),
    ).rejects.toThrow('disabled');
    expect(bridge.calls).toHaveLength(0);
  });
});

class ScopedNative extends StubNative {
  mode = 'normal';
  snapshots = 0;
  scopeFailure?: NativeError;
  topLevelFailure?: NativeError;
  applications = async () => [{ name: 'Example', id: 'example', running: true }];
  protected async run(args: string[], input?: string): Promise<any> {
    if (args[0] === 'list-surfaces') throw new Error('Global discovery must not run');
    if (args[0] !== 'snapshot') return super.run(args, input);
    this.calls.push({ args, input });
    this.snapshots++;
    const readFailure = args.includes('--root') ? this.scopeFailure : this.topLevelFailure;
    if (readFailure) throw readFailure;
    if (this.mode === 'permission') throw new NativeError('PERM_DENIED', 'No access');
    if (this.mode === 'stale' && args.includes('--root'))
      throw new NativeError('STALE_REF', 'Region changed');
    if (this.snapshots === 1 && this.mode === 'limit')
      throw new NativeError('APP_UNRESPONSIVE', 'Accessibility node budget exceeded');
    const wide = this.snapshots === 1 && this.mode === 'wide';
    return {
      snapshot_id: 's1',
      complete: !(this.snapshots === 1 && this.mode === 'partial'),
      window: { id: 'w1', title: 'Example' },
      tree: {
        role: 'window',
        children: wide
          ? Array.from({ length: 2100 }, () => ({ role: 'statictext', name: 'row' }))
          : [
              { role: 'group', name: 'Composer', ref_id: '@s1:e1', children_count: NATIVE_READ_NODE_BUDGET + 1 },
              { role: 'button', name: 'New Mail', ref_id: '@s1:e2', available_actions: ['Click'] },
            ],
      },
    };
  }
}
describe('On-demand native scopes', () => {
  it('reads three levels without global surface discovery and exposes unread branches', async () => {
    const bridge = new ScopedNative();
    const o = await bridge.observe({ app: 'Example', windowId: 'w1' });
    const args = bridge.calls.find((c) => c.args[0] === 'snapshot')!.args;
    expect(args[args.indexOf('--max-depth') + 1]).toBe('3');
    expect(args).toContain('--skeleton');
    expect(o.snapshots[0].elements[0].childrenCount).toBe(NATIVE_READ_NODE_BUDGET + 1);
    const candidates = desktopCandidates(
      o,
      TaskInputSchema.parse({ goal: 'Compose a draft', provider: 'jev' }),
    );
    expect(candidates.some((c) => c.operation === 'INSPECT_REGION' && c.name === 'Composer')).toBe(true);
    const context = await bridge.act(
      candidates.find((c) => c.operation === 'INSPECT_REGION')!,
      o,
      undefined,
      false,
      new AbortController().signal,
    );
    expect(context.scopePath).toEqual([{ ref: '@s1:e1', name: 'Composer' }]);
    await bridge.observe(context);
    const drill = bridge.calls.filter((c) => c.args[0] === 'snapshot').at(-1)!.args;
    expect(drill).toContain('--root');
    expect(drill).not.toContain('--skeleton');
  });
  it.each(['partial', 'limit'])(
    'reduces an oversized or incomplete chunk to one level: %s',
    async (mode) => {
      const bridge = new ScopedNative();
      bridge.mode = mode;
      const o = await bridge.observe({ app: 'Example', windowId: 'w1' });
      expect(
        bridge.calls
          .filter((c) => c.args[0] === 'snapshot')
          .map((c) => c.args[c.args.indexOf('--max-depth') + 1]),
      ).toEqual(['3', '1']);
      expect(o.snapshots[0].complete).toBe(true);
      expect(o.notices.some((n) => n.includes('one level'))).toBe(true);
    },
  );
  it('does not hide permission errors behind a shallower retry', async () => {
    const bridge = new ScopedNative();
    bridge.mode = 'permission';
    await expect(bridge.observe({ app: 'Example', windowId: 'w1' })).rejects.toThrow('No access');
    expect(bridge.snapshots).toBe(1);
  });
  it('distinguishes reading a subtree from moving keyboard focus', async () => {
    const bridge = new ScopedNative();
    const observation = await bridge.observe({ app: 'Example', windowId: 'w1', rootRef: '@s1:e1' });
    expect(
      observation.notices.some((notice) =>
        notice.includes('Browsing or inspecting a branch does not focus it'),
      ),
    ).toBe(true);
    expect(bridge.calls.every((call) => ['snapshot', 'list-windows'].includes(call.args[0]))).toBe(true);
  });
  it('recovers a stale scope by reading the window without sending input', async () => {
    const bridge = new ScopedNative();
    bridge.mode = 'stale';
    const o = await bridge.observe({
      app: 'Example',
      windowId: 'w1',
      rootRef: '@s1:e9',
      scopePath: [{ ref: '@s1:e9', name: 'Old region' }],
    });
    expect(o.context.rootRef).toBeUndefined();
    expect(o.context.scopePath).toBeUndefined();
    expect(bridge.calls.every((c) => ['snapshot', 'list-windows'].includes(c.args[0]))).toBe(true);
  });
  it('drops an old window scope when the selected window no longer exists', async () => {
    const bridge = new ScopedNative();
    const o = await bridge.observe({
      app: 'Example',
      windowId: 'closed',
      surface: 'menu',
      rootRef: '@s1:e9',
      scopePath: [{ ref: '@s1:e9', name: 'Old region' }],
    });
    expect(o.context).toEqual({ app: 'Example', windowId: 'w1', surface: 'window' });
    expect(bridge.calls.find((c) => c.args[0] === 'snapshot')!.args).not.toContain('--root');
  });
});

describe('Optional surface absence', () => {
  class OptionalSurfaceNative extends ScopedNative {
    failure = new NativeError('ELEMENT_NOT_FOUND', 'No open surface', { delivery: 'not_delivered', retry: 'safe' });
    protected async run(args: string[], input?: string): Promise<any> {
      if (args[0] === 'snapshot' && !args.includes('--root') &&
          ['menu', 'sheet', 'alert', 'popover'].includes(args[args.indexOf('--surface') + 1])) {
        this.calls.push({ args, input });
        throw this.failure;
      }
      return super.run(args, input);
    }
  }
  it.each(['menu', 'sheet', 'alert', 'popover'])('returns to the window when %s is absent, without sending input', async surface => {
    const bridge = new OptionalSurfaceNative();
    const result = await bridge.observe({ app: 'Example', windowId: 'w1', surface });
    expect(result.context.surface).toBe('window');
    expect(result.snapshots[0].elements.some(e => e.name === 'New Mail')).toBe(true);
    expect(result.notices.join()).toContain('not open');
    expect(bridge.calls.map(c => c.args[0])).toEqual(['list-windows', 'snapshot', 'snapshot']);
  });
  it.each(['PERM_DENIED', 'APP_UNRESPONSIVE'])('does not turn %s into an absent-surface result', async code => {
    const bridge = new OptionalSurfaceNative();
    bridge.failure = new NativeError(code, 'Read failed', { delivery: 'not_delivered', retry: 'safe' });
    await expect(bridge.observe({ app: 'Example', windowId: 'w1', surface: 'alert' })).rejects.toThrow('Read failed');
    expect(bridge.calls.filter(c => c.args[0] === 'snapshot')).toHaveLength(1);
  });
  it('does not treat a missing scoped element as proof that its whole surface disappeared', async () => {
    const bridge = new ScopedNative();
    bridge.scopeFailure = new NativeError('ELEMENT_NOT_FOUND', 'Missing scoped element', { delivery: 'not_delivered', retry: 'safe' });
    await expect(bridge.observe({ app: 'Example', windowId: 'w1', surface: 'alert', rootRef: '@old:e1' }))
      .rejects.toThrow('Missing scoped element');
  });
});

describe('Invalid native scope reads', () => {
  const requested = {
    app: 'Example',
    windowId: 'w1',
    surface: 'window',
    rootRef: '@old:e1',
    scopePath: [{ ref: '@old:e1', name: 'Content' }],
  };
  const details = {
    kind: 'surface_read',
    attribute: 'AXRole',
    ax_error: -25202,
    resolution_phase: 'remote_token',
    retryable: false,
    path_fast: true,
  };
  const disposition = { delivery: 'not_delivered', retry: 'safe' };
  const changedSurface = {
    kind: 'surface_read',
    attribute: 'AXRole',
    ax_error: -25202,
    complete: false,
    retryable: false,
  };
  const remoteError = () =>
    new NativeError('APP_UNRESPONSIVE', 'Cannot read the remote element', disposition, details);

  it.each([
    ['remote token', details],
    ['changed surface', changedSurface],
    ['remote token without AXRole failure', { ...details, attribute: 'AXTitle', ax_error: -25201 }],
  ])(
    'drops an invalid %s scope and reads the same window top level once, without input',
    async (_name, failureDetails) => {
      const bridge = new ScopedNative();
      bridge.scopeFailure = new NativeError(
        'APP_UNRESPONSIVE',
        'Scoped read failed',
        disposition,
        failureDetails as Record<string, unknown>,
      );
      const result = await bridge.observe(requested);
      expect(result.context).toEqual({ app: 'Example', windowId: 'w1', surface: 'window' });
      expect(result.snapshots[0].elements.some((element) => element.name === 'New Mail')).toBe(true);
      expect(result.notices.some((notice) => notice.includes('instead of reusing stale references'))).toBe(
        true,
      );
      expect(bridge.calls.map((call) => call.args[0])).toEqual(['list-windows', 'snapshot', 'snapshot']);
      expect(bridge.calls[1].args).toContain('--root');
      expect(bridge.calls[2].args).not.toContain('--root');
      expect(bridge.calls[2].args).toContain('--skeleton');
      expect(bridge.calls[2].args[bridge.calls[2].args.indexOf('--window-id') + 1]).toBe('w1');
      expect(requested.rootRef).toBe('@old:e1');
    },
  );

  it.each([
    ['different error code', new NativeError('ACTION_NOT_SUPPORTED', 'Read failed', disposition, details)],
    [
      'different kind',
      new NativeError('APP_UNRESPONSIVE', 'Read failed', disposition, { ...details, kind: 'different' }),
    ],
    [
      'different resolution phase without an AXRole failure',
      new NativeError('APP_UNRESPONSIVE', 'Read failed', disposition, {
        ...details,
        resolution_phase: 'path',
        attribute: 'AXTitle',
      }),
    ],
    [
      'different surface attribute',
      new NativeError('APP_UNRESPONSIVE', 'Read failed', disposition, {
        ...changedSurface,
        attribute: 'AXValue',
      }),
    ],
    [
      'different accessibility error',
      new NativeError('APP_UNRESPONSIVE', 'Read failed', disposition, {
        ...changedSurface,
        ax_error: -25201,
      }),
    ],
    [
      'uncertain delivery',
      new NativeError('APP_UNRESPONSIVE', 'Read failed', { ...disposition, delivery: 'unknown' }, details),
    ],
    [
      'unsafe retry',
      new NativeError('APP_UNRESPONSIVE', 'Read failed', { ...disposition, retry: 'unsafe' }, details),
    ],
    ['missing disposition', new NativeError('APP_UNRESPONSIVE', 'Read failed', undefined, details)],
    ['ordinary unresponsive app', new NativeError('APP_UNRESPONSIVE', 'Application did not respond')],
  ])('does not reinterpret %s as an invalid scope', async (_name, error) => {
    const bridge = new ScopedNative();
    bridge.scopeFailure = error as NativeError;
    await expect(bridge.observe(requested)).rejects.toBe(error);
    expect(bridge.snapshots).toBe(1);
  });

  it('does not retry this error when the original read was already top level', async () => {
    const bridge = new ScopedNative();
    bridge.topLevelFailure = remoteError();
    await expect(bridge.observe({ app: 'Example', windowId: 'w1' })).rejects.toBe(bridge.topLevelFailure);
    expect(bridge.snapshots).toBe(1);
  });

  it('propagates a failed fresh top-level read rather than retrying either read', async () => {
    const bridge = new ScopedNative();
    bridge.scopeFailure = remoteError();
    bridge.topLevelFailure = remoteError();
    await expect(bridge.observe(requested)).rejects.toBe(bridge.topLevelFailure);
    expect(bridge.snapshots).toBe(2);
    expect(bridge.calls.filter((call) => call.args.includes('--root'))).toHaveLength(1);
  });
});

type WindowFixture = { id: string; is_focused?: boolean; accessible?: boolean };
class TransientWindowNative extends ScopedNative {
  inventories = 0;
  snapshotAttempts = 0;
  refreshed: WindowFixture[] = [{ id: 'w1', is_focused: true, accessible: true }];
  failure = new NativeError(
    'ACTION_NOT_SUPPORTED',
    'Window exists but is not exposed through accessibility',
    undefined,
    { kind: 'window_without_accessibility_element', window_id: 'suggestion-popup' },
  );
  refreshFailure?: NativeError;
  replacementFailure?: NativeError;
  protected async run(args: string[], input?: string): Promise<any> {
    if (args[0] === 'list-windows') {
      this.calls.push({ args, input });
      if (this.inventories++ === 0) return [...this.refreshed, { id: 'suggestion-popup', accessible: true }];
      if (this.refreshFailure) throw this.refreshFailure;
      return this.refreshed;
    }
    if (args[0] === 'snapshot') {
      this.snapshotAttempts++;
      const error = this.snapshotAttempts === 1 ? this.failure : this.replacementFailure;
      if (error) {
        this.calls.push({ args, input });
        throw error;
      }
    }
    return super.run(args, input);
  }
}

describe('Transient native window observation', () => {
  const requested = {
    app: 'Example',
    windowId: 'suggestion-popup',
    surface: 'popover',
    rootRef: '@old:e1',
    scopePath: [{ ref: '@old:e1', name: 'Suggestions' }],
  };

  it.each(['unexposed', 'closed'] as const)(
    'reads a fresh accessible window after the selected window becomes %s, without input replay',
    async (mode) => {
      const bridge = new TransientWindowNative();
      if (mode === 'closed') bridge.failure = new NativeError('WINDOW_NOT_FOUND', 'Window not found');
      const result = await bridge.observe(requested);
      expect(result.context).toEqual({ app: 'Example', windowId: 'w1', surface: 'window' });
      expect(result.windows).toEqual([{ id: 'w1', app: 'Example', title: '', focused: true }]);
      expect(result.snapshots[0].windowId).toBe('w1');
      expect(result.notices.some((n) => n.includes('without repeating the previous action'))).toBe(true);
      expect(bridge.calls.map((c) => c.args[0])).toEqual([
        'list-windows',
        'snapshot',
        'list-windows',
        'snapshot',
      ]);
      const fresh = bridge.calls.at(-1)!.args;
      expect(fresh).not.toContain('--root');
      expect(fresh[fresh.indexOf('--surface') + 1]).toBe('window');
      expect(fresh[fresh.indexOf('--window-id') + 1]).toBe('w1');
      expect(requested.rootRef).toBe('@old:e1');
    },
  );

  it('uses the only accessible alternative even when an inaccessible window is focused', async () => {
    const bridge = new TransientWindowNative();
    bridge.refreshed = [
      { id: 'w1', accessible: true },
      { id: 'unavailable', accessible: false, is_focused: true },
    ];
    expect((await bridge.observe(requested)).context.windowId).toBe('w1');
  });

  it('selects the uniquely focused accessible alternative among several windows', async () => {
    const bridge = new TransientWindowNative();
    bridge.refreshed = [
      { id: 'other', accessible: true },
      { id: 'w1', accessible: true, is_focused: true },
    ];
    expect((await bridge.observe(requested)).context.windowId).toBe('w1');
  });

  it.each([
    [
      { id: 'w1', accessible: true },
      { id: 'w2', accessible: true },
    ],
    [
      { id: 'w1', accessible: true, is_focused: true },
      { id: 'w2', accessible: true, is_focused: true },
    ],
    [{ id: 'w1', accessible: false, is_focused: true }],
    [{ id: 'w1', is_focused: true }],
    [{ id: 'suggestion-popup', accessible: true, is_focused: true }],
    [],
  ] as WindowFixture[][])('does not guess an accessible replacement from %j', async (...windows) => {
    const bridge = new TransientWindowNative();
    bridge.refreshed = windows;
    await expect(bridge.observe(requested)).rejects.toBe(bridge.failure);
    expect(bridge.snapshotAttempts).toBe(1);
    expect(bridge.inventories).toBe(2);
  });

  it.each([
    new NativeError('PERM_DENIED', 'No access'),
    new NativeError('ACTION_NOT_SUPPORTED', 'Unrelated unsupported operation'),
    new NativeError('ACTION_NOT_SUPPORTED', 'Different failure kind', undefined, { kind: 'different_kind' }),
  ])('propagates unrelated errors without window recovery: $code', async (error) => {
    const bridge = new TransientWindowNative();
    bridge.failure = error;
    await expect(bridge.observe(requested)).rejects.toBe(error);
    expect(bridge.inventories).toBe(1);
    expect(bridge.snapshotAttempts).toBe(1);
  });

  it('propagates a failure while refreshing the inventory', async () => {
    const bridge = new TransientWindowNative();
    bridge.refreshFailure = new NativeError('PERM_DENIED', 'Inventory access denied');
    await expect(bridge.observe(requested)).rejects.toBe(bridge.refreshFailure);
    expect(bridge.snapshotAttempts).toBe(1);
  });

  it('does not repeatedly change windows if the replacement read also fails', async () => {
    const bridge = new TransientWindowNative();
    bridge.replacementFailure = new NativeError('WINDOW_NOT_FOUND', 'Replacement disappeared');
    await expect(bridge.observe(requested)).rejects.toBe(bridge.replacementFailure);
    expect(bridge.inventories).toBe(2);
    expect(bridge.snapshotAttempts).toBe(2);
  });
});
