import { setTimeout as delay } from 'node:timers/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  Application,
  DesktopCandidate,
  DesktopContext,
  DesktopObservation,
  Snapshot,
} from '../../../../packages/contracts/src/index';
import { NativeClient, NativeError } from './native-client';
import { flattenTree, treeText, accessibilityTree } from './accessibility-tree';
import { defaultBrowserBundle, searchIndexedApplications } from './app-discovery';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ActionVerifier, type ActionReport } from './action-verification';
import { focusAndPaste, nativePasteRunner } from './focus-and-paste';
import { activeModal } from './modal-scope';
import { readBudgetedTree } from './tree-budget';

/** startDepth above 3 asks for one direct deep read before falling back to the layered climb. */
export type ObserveOptions = { startDepth?: number; /** What is being looked for; a web page uses it to list matches beyond its size limit. */ query?: string };
export interface WorkspaceBridge {
  applications(signal?: AbortSignal): Promise<Application[]>;
  windowInventory?(app: string, signal?: AbortSignal): Promise<{ id: string; title: string }[]>;
  observe(context: DesktopContext, signal?: AbortSignal, options?: ObserveOptions): Promise<DesktopObservation>;
  /** Hand a web address to the system, which opens it in the user's own browser. */
  openUrl?(url: string, signal: AbortSignal): Promise<DesktopContext>;
  /** Read one live property of an observed element without acting on it. */
  probe?(ref: string, property: 'states' | 'bounds', signal?: AbortSignal): Promise<unknown>;
  act(
    candidate: DesktopCandidate,
    observation: DesktopObservation,
    text: string | undefined,
    allowPhysical: boolean,
    signal: AbortSignal,
  ): Promise<DesktopContext>;
  takeActionReport?(): ActionReport | undefined;
}
export const KEYS = [
  'return',
  'escape',
  'tab',
  'shift+tab',
  'space',
  'up',
  'down',
  'left',
  'right',
  'cmd+n',
  'cmd+t',
  'cmd+o',
  'cmd+f',
  'cmd+l',
  'cmd+s',
  'cmd+a',
  'cmd+z',
  'cmd+shift+g',
];
/** Only ordinary web addresses, with no embedded credentials, may be handed to the system. */
export function validatedUrl(text: string): string {
  let url: URL;
  try { url = new URL(text.trim()); } catch { throw new Error('That is not a complete web address. Give the full address, starting with https://.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only http and https addresses can be opened.');
  if (url.username || url.password) throw new Error('Addresses that carry a user name or password are not opened.');
  if (url.href.length > 2000) throw new Error('That address is too long.');
  return url.href;
}
const surfaces = ['window', 'menubar', 'menu', 'sheet', 'alert', 'popover', 'focused'];
const optionalSurfaces = new Set(['menu', 'sheet', 'alert', 'popover']);

function absentSurface(error: unknown, surface: string, scoped: boolean): boolean {
  if (scoped || !optionalSurfaces.has(surface) || !(error instanceof NativeError)) return false;
  if (error.details?.kind === 'surface_absent' && error.details.complete === true) return true;
  // Window-scoped native surface queries currently use ELEMENT_NOT_FOUND for
  // an absent overlay. This is an observation result, not a failed mutation.
  const disposition = error.disposition as { delivery?: string; retry?: string } | undefined;
  return error.code === 'ELEMENT_NOT_FOUND' && disposition?.delivery === 'not_delivered' && disposition.retry === 'safe';
}
function readLimit(error: unknown): boolean {
  return (
    error instanceof NativeError &&
    (error.code === 'OUTPUT_LIMIT' ||
      (error.code === 'APP_UNRESPONSIVE' && /budget|limit/i.test(error.message)))
  );
}
function reportedOverlay(result: any): string | undefined {
  const open = (result?.surfaces || []).map((s: any) =>
    typeof s === 'string' ? s : s.kind || s.surface || s.type,
  );
  return ['alert', 'sheet', 'menu', 'popover'].find((kind) => open.includes(kind));
}
export class WorkspaceDesktopBridge extends NativeClient implements WorkspaceBridge {
  async windowInventory(app: string, signal?: AbortSignal): Promise<{ id: string; title: string }[]> {
    try {
      const windows = await this.run(['list-windows', '--app', app], undefined, signal);
      return windows.map((window: { id: string; title?: string }) => ({ id: window.id, title: window.title || '' }));
    } catch (error) {
      if (error instanceof NativeError && error.code === 'APP_NOT_FOUND') return [];
      throw error;
    }
  }
  private lastAction?: ActionReport;
  takeActionReport(): ActionReport | undefined {
    const report = this.lastAction;
    this.lastAction = undefined;
    return report;
  }
  private installed?: Application[];
  private discovered = new Map<string, Application[]>();
  protected searchApplications(query: string, signal?: AbortSignal): Promise<Application[]> {
    return searchIndexedApplications(query, signal);
  }
  async applications(signal?: AbortSignal): Promise<Application[]> {
    const data = await this.run(['list-apps'], undefined, signal);
    const running: Application[] = (data.apps || [])
      .filter((a: any) => a.presentation === 'foreground' && a.pid !== process.pid)
      .map((a: any) => ({ name: a.name, id: a.bundle_id || a.name, running: true, pid: a.pid }));
    if (!this.installed) {
      const directories = [
        '/Applications',
        '/System/Applications',
        '/System/Applications/Utilities',
        path.join(os.homedir(), 'Applications'),
      ];
      const entries = await Promise.all(
        directories.map((dir) => readdir(dir, { withFileTypes: true }).catch(() => [])),
      );
      this.installed = entries.flatMap((items) =>
        items
          .filter((item) => item.name.endsWith('.app'))
          .map((item) => ({
            name: item.name.slice(0, -4),
            id: item.name.slice(0, -4),
            running: false,
          })),
      );
    }
    const byName = new Map(
      [...this.installed, ...[...this.discovered.values()].flat()].map((app) => [
        app.name.toLowerCase(),
        app,
      ]),
    );
    for (const app of running) byName.set(app.name.toLowerCase(), app);
    return [...byName.values()]
      .filter((a) => !['Electron', 'Desktop Assistant Lab'].includes(a.name))
      .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
  }
  /** The address is passed as one argument to `open`; nothing is interpreted by a shell. */
  async openUrl(url: string, signal: AbortSignal): Promise<DesktopContext> {
    signal.throwIfAborted();
    try { await promisify(execFile)('/usr/bin/open', [validatedUrl(url)], { timeout: 10_000 }); }
    catch (error: any) {
      // `open` exiting with an error means the system refused the address. Being cut off by the
      // timeout says nothing about whether the browser had already taken it.
      const cutOff = error?.killed === true || !!error?.signal;
      throw new NativeError('OPEN_URL', cutOff ? 'Opening the address did not finish in time. It may still have opened.'
        : 'The system could not open that address.', { delivery: cutOff ? 'unknown' : 'not_delivered', retry: 'inspect' });
    }
    const bundle = (await defaultBrowserBundle(signal))?.toLowerCase();
    const browser = bundle ? (await this.applications(signal)).find(a => a.running && a.id.toLowerCase() === bundle) : undefined;
    return browser ? { app: browser.name } : {};
  }
  probe(ref: string, property: 'states' | 'bounds', signal?: AbortSignal): Promise<unknown> {
    return this.run(['get', ref, '--property', property], undefined, signal);
  }
  async observe(requested: DesktopContext, signal?: AbortSignal, options: ObserveOptions = {}): Promise<DesktopObservation> {
    signal?.throwIfAborted();
    const context = { ...requested },
      notices: string[] = [];
    const applications = await this.applications(signal);
    const observation: DesktopObservation = {
      id: randomUUID(),
      capturedAt: Date.now(),
      context,
      applications,
      windows: [],
      snapshots: [],
      notices,
    };
    if (context.appSearch) {
      const results = this.discovered.get(context.appSearch) || [];
      observation.applications = results.map((a) => applications.find((current) => current.id === a.id) || a);
      notices.push(
        'Spotlight application search for ' +
          JSON.stringify(context.appSearch) +
          ': ' +
          results.length +
          ' verified installed app(s). Select the matching OPEN_APP; do not assume it has opened yet.',
      );
      return observation;
    }
    if (!context.app) return observation;
    let nativeWindows: any[];
    try {
      nativeWindows = await this.run(['list-windows', '--app', context.app], undefined, signal);
    } catch (error) {
      if (error instanceof NativeError && error.code === 'APP_NOT_FOUND') {
        notices.push('App is not running. Choose OPEN_APP to launch it.');
        return observation;
      }
      throw error;
    }
    observation.windows = nativeWindows.map((w) => ({
      id: w.id,
      title: w.title || '',
      app: context.app!,
      focused: w.is_focused === true,
    }));
    if (!nativeWindows.some((w) => w.id === context.windowId)) {
      const selected =
        nativeWindows.find((w) => w.is_focused) ||
        (nativeWindows.length === 1 ? nativeWindows[0] : undefined);
      if (context.windowId) {
        delete context.rootRef;
        delete context.scopePath;
        delete context.surface;
      }
      context.windowId = selected?.id;
    }
    // list-surfaces walks the whole app and can exhaust its independent 2,048-node
    // budget before a small window read even begins. Follow action-reported overlays
    // and visible modal nodes instead of making that global scan a prerequisite.
    let surface = context.surface || (context.windowId ? 'window' : 'menubar');
    if (surface === 'window' && !context.windowId && nativeWindows.length > 1) surface = 'menubar';
    context.surface = surface;
    const read = async (surfaceName: string): Promise<Snapshot | undefined> => {
      const args = [
        'snapshot',
        '--compact',
        '--include-bounds',
        '--max-depth',
        '3',
        '--timeout-ms',
        '8000',
      ];
      if (context.rootRef) args.push('--root', context.rootRef);
      else {
        args.push('--app', context.app!, '--surface', surfaceName);
        if (surfaceName === 'window') args.push('--skeleton');
        if (context.windowId && surfaceName !== 'menubar') args.push('--window-id', context.windowId);
      }
      let data;
      try {
        data = await readBudgetedTree(async depth => {
          const bounded = depth > 3 ? args.filter(arg => arg !== '--skeleton') : [...args];
          bounded[bounded.indexOf('--max-depth') + 1] = String(depth);
          return this.run(bounded, undefined, signal);
        }, readLimit, notices, options.startDepth);
      } catch (error) {
        if (absentSurface(error, surfaceName, !!context.rootRef)) {
          notices.push('The requested ' + surfaceName + ' surface is not open.');
          return;
        }
        throw error;
      }
      if (context.rootRef && data.tree?.ref_id) {
        context.rootRef = data.tree.ref_id;
        if (context.scopePath?.length)
          context.scopePath = [
            ...context.scopePath.slice(0, -1),
            { ...context.scopePath.at(-1)!, ref: data.tree.ref_id },
          ];
      }
      if (data.surface_absent === true || !data.tree) {
        notices.push('No accessible ' + surfaceName + ' surface is currently exposed.');
        return;
      }
      return {
        id: data.snapshot_id,
        app: context.app!,
        windowId: data.window?.id || context.windowId || '',
        windowTitle: data.window?.title || nativeWindows.find((w) => w.id === context.windowId)?.title || '',
        surface: surfaceName,
        complete: data.complete === true,
        capturedAt: Date.now(),
        elements: flattenTree(data.tree),
        text: treeText(data.tree),
        tree: accessibilityTree(data.tree),
      };
    };
    const readCurrentScope = async (): Promise<Snapshot | undefined> => {
      try {
        return await read(surface);
      } catch (error) {
        if (!context.rootRef || !(error instanceof NativeError)) throw error;
        const disposition = error.disposition as { delivery?: string; retry?: string } | undefined;
        const invalidScope =
          error.code === 'APP_UNRESPONSIVE' &&
          error.details?.kind === 'surface_read' &&
          (error.details.resolution_phase === 'remote_token' ||
            (error.details.attribute === 'AXRole' && error.details.ax_error === -25202)) &&
          disposition?.delivery === 'not_delivered' &&
          disposition.retry === 'safe';
        if (!['STALE_REF', 'SNAPSHOT_NOT_FOUND'].includes(error.code) && !invalidScope) throw error;
        delete context.rootRef;
        delete context.scopePath;
        notices.push(
          'The selected region changed. Reading a fresh top level instead of reusing stale references.',
        );
        return read(surface);
      }
    };
    let recoveredWindow = false;
    const readSelectedWindow = async (): Promise<Snapshot | undefined> => {
      try {
        return await readCurrentScope();
      } catch (error) {
        if (
          recoveredWindow ||
          !context.windowId ||
          !(error instanceof NativeError) ||
          !(
            error.code === 'WINDOW_NOT_FOUND' ||
            (error.code === 'ACTION_NOT_SUPPORTED' &&
              error.details?.kind === 'window_without_accessibility_element')
          )
        )
          throw error;
        const previousWindow = context.windowId;
        nativeWindows = await this.run(['list-windows', '--app', context.app!], undefined, signal);
        const accessible = nativeWindows.filter((w) => w.id !== previousWindow && w.accessible === true);
        const focused = accessible.filter((w) => w.is_focused === true);
        const replacement =
          focused.length === 1 ? focused[0] : accessible.length === 1 ? accessible[0] : undefined;
        if (!replacement) throw error;
        recoveredWindow = true;
        observation.windows = nativeWindows.map((w) => ({
          id: w.id,
          title: w.title || '',
          app: context.app!,
          focused: w.is_focused === true,
        }));
        context.windowId = replacement.id;
        delete context.rootRef;
        delete context.scopePath;
        context.surface = surface = 'window';
        notices.push(
          'The selected window is no longer accessible. Reading the refreshed accessible window ' +
            replacement.id +
            ' without repeating the previous action.',
        );
        return read(surface);
      }
    };
    let main = await readSelectedWindow();
    if (!main && optionalSurfaces.has(surface) && context.windowId) {
      // An optional overlay can close between observation and inspection. Read
      // the underlying window afresh; never replay a dismissal or other input.
      delete context.rootRef;
      delete context.scopePath;
      context.surface = surface = 'window';
      main = await readSelectedWindow();
    }
    // A modal found in this bounded read takes precedence over controls behind it.
    const modal = activeModal(main?.tree);
    if (modal?.ref && modal.ref !== context.rootRef) {
      context.rootRef = modal.ref;
      context.scopePath = [...(context.scopePath || []), { ref: modal.ref, name: modal.name || modal.role }];
      main = await readSelectedWindow();
      notices.push('Following the visible ' + modal.role + ' before other window controls.');
    }
    if (main) observation.snapshots.push(main);
    if (main && context.rootRef && !main.elements.some((element) => element.states.includes('focused')))
      notices.push(
        'This scoped read does not expose a keyboard-focused control. Browsing or inspecting a branch does not focus it. Keyboard input still goes to the actual focused control, which may be elsewhere. Use an observed FOCUS action or Tab/Shift+Tab and observe again before editing this region.',
      );
    if (main?.elements.some((element) => element.value.includes('\ufffc')))
      notices.push(
        'Some text controls contain embedded objects (Unicode object-replacement characters). Inspect their child accessibility nodes for committed tokens or selections; these characters are not unentered text.',
      );
    if (main?.elements.some((e) => e.childrenCount))
      notices.push(
        'Only this shallow hierarchy chunk was fetched. INSPECT_REGION fetches children of a selected branch; unexpanded children are not absent. GO_PARENT and GO_ROOT can read previous scopes.',
      );
    // Never target a window behind an open overlay. Menus are an explicit read choice.
    if (main && !main.complete)
      notices.push(
        'Native tree is incomplete. Inspect a region or change surface; mutation choices are disabled for this tree.',
      );
    return observation;
  }
  async act(
    candidate: DesktopCandidate,
    observation: DesktopObservation,
    text: string | undefined,
    allowPhysical: boolean,
    signal: AbortSignal,
  ): Promise<DesktopContext> {
    this.lastAction = undefined;
    signal.throwIfAborted();
    const context = { ...observation.context };
    // The helper marks every failed read "not delivered". After input has been sent, a failed
    // window inventory (the app quit, or was busy) must not turn into "nothing was sent".
    const windowsAfter = async (): Promise<any[] | undefined> => {
      try { return await this.run(['list-windows', '--app', context.app!]); } catch { return undefined; }
    };
    if (candidate.operation === 'SEARCH_APPS') {
      if (!text?.trim() || text.length > 200)
        throw new Error('App search needs a specific application name from the user instruction.');
      this.discovered.set(text, await this.searchApplications(text, signal));
      return { appSearch: text };
    }
    if (candidate.operation === 'OPEN_APP') {
      const app = observation.applications.find((a) => a.id === candidate.app || a.name === candidate.app);
      if (!app) throw new Error('App was not in the observed inventory.');
      const result = await this.run(['launch', app.id, '--activate']);
      return { app: app.name, windowId: result.window?.id };
    }
    if (candidate.app !== context.app) throw new Error('Action app does not match the observed app.');
    if (candidate.operation === 'WAIT') {
      await delay(750, undefined, { signal });
      return context;
    }
    if (candidate.operation === 'READ_WINDOW') {
      if (!observation.windows.some((window) => window.id === candidate.windowId))
        throw new Error('Window was not observed.');
      return { app: candidate.app, windowId: candidate.windowId, surface: 'window' };
    }
    if (candidate.operation === 'FOCUS_WINDOW') {
      if (!observation.windows.some((w) => w.id === candidate.windowId))
        throw new Error('Window was not observed.');
      await this.run(['focus-window', '--app', candidate.app, '--window-id', candidate.windowId!]);
      return { app: candidate.app, windowId: candidate.windowId, surface: 'window' };
    }
    if (candidate.operation === 'READ_SURFACE') {
      if (!surfaces.includes(candidate.surface || '')) throw new Error('Unsupported surface.');
      return { app: candidate.app, windowId: context.windowId, surface: candidate.surface };
    }
    const snapshot = observation.snapshots.find((s) => s.id === candidate.snapshotId);
    if (!snapshot) throw new Error('Action snapshot was not observed.');
    if (candidate.operation === 'PRESS') {
      if (!KEYS.includes(candidate.key || '') || !snapshot.complete)
        throw new Error('Unsupported key or incomplete observation.');
      if (!context.windowId || snapshot.windowId !== context.windowId)
        throw new Error('Keyboard input needs a selected window.');
      // Headless press on macOS targets a process, not a particular document. Require the intended window to be focused.
      const windows = await this.run(['list-windows', '--app', candidate.app], undefined, signal);
      if (!windows.some((w: any) => w.id === context.windowId && w.is_focused))
        throw new NativeError(
          'STALE_REF',
          'Keyboard target lost focus. Select its window again before sending a key.',
          { delivery: 'not_delivered', retry: 'safe' },
        );
      signal.throwIfAborted();
      const result = await this.run([
        'press',
        candidate.key!,
        '--app',
        candidate.app,
        '--window-id',
        context.windowId,
      ]);
      let after = await windowsAfter();
      if (!after) return { app: context.app, surface: 'window' };
      let fresh = after.filter((w: any) => !observation.windows.some((old) => old.id === w.id));
      // New-window shortcuts can return before macOS publishes the new AX window.
      const deadline = Date.now() + 3000;
      while (candidate.key === 'cmd+n' && !fresh.some((w: any) => w.is_focused) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        after = (await windowsAfter()) ?? after;
        fresh = after.filter((w: any) => !observation.windows.some((old) => old.id === w.id));
      }
      const focusedNew = fresh.filter((w: any) => w.is_focused);
      return {
        app: context.app,
        windowId: focusedNew.length === 1 ? focusedNew[0].id : context.windowId,
        surface: reportedOverlay(result),
      };
    }
    const expected = snapshot.elements.find((e) => e.ref === candidate.targetRef);
    if (!expected) throw new Error('Action target is outside its snapshot.');
    if (candidate.operation === 'INSPECT_REGION') {
      if (expected.ref === context.rootRef) throw new Error('This region is already the current root.');
      const scopePath = [
        ...(context.scopePath || []),
        {
          ref: expected.ref,
          name: expected.name || expected.description || expected.nativeId || expected.role,
        },
      ];
      if (scopePath.length > 50) throw new Error('Hierarchy depth limit reached.');
      return { ...context, rootRef: expected.ref, scopePath };
    }
    if (!snapshot.complete) throw new Error('No mutations from incomplete trees.');
    if (candidate.operation === 'FOCUS_AND_PASTE') {
      if (
        snapshot.app !== candidate.app ||
        snapshot.windowId !== candidate.windowId ||
        candidate.windowId !== context.windowId
      )
        throw new Error('Paste target does not belong to the selected window.');
      this.lastAction = await focusAndPaste(
        this.run.bind(this),
        nativePasteRunner(this.binary, this.stateRoot),
        candidate,
        expected,
        text,
        signal,
      );
      return context;
    }
    if (
      expected.states.some((s) => ['disabled', 'hidden', 'readonly'].includes(s)) &&
      ['SET_VALUE', 'TYPE'].includes(candidate.operation)
    )
      throw new Error('Text target is unavailable.');
    const capabilities: Partial<Record<DesktopCandidate['operation'], string[]>> = {
      CLICK: ['Click'],
      DOUBLE_CLICK: ['DoubleClick', 'Click'],
      RIGHT_CLICK: ['RightClick', 'ShowMenu'],
      SET_VALUE: ['SetValue'],
      TYPE: ['Type', 'TypeText'],
      FOCUS: ['SetFocus'],
      SELECT: ['Select'],
      CHECK: ['Check', 'Toggle'],
      UNCHECK: ['Uncheck', 'Toggle'],
      EXPAND: ['Expand'],
      COLLAPSE: ['Collapse'],
      SCROLL: ['Scroll'],
      SCROLL_TO: ['ScrollTo'],
    };
    if (!capabilities[candidate.operation]?.some((action) => expected.actions.includes(action)))
      throw new Error('Target does not advertise this action.');
    const command: Record<string, string> = {
      CLICK: 'click',
      DOUBLE_CLICK: 'double-click',
      RIGHT_CLICK: 'right-click',
      SET_VALUE: 'set-value',
      TYPE: 'type',
      FOCUS: 'focus',
      SELECT: 'select',
      CHECK: 'check',
      UNCHECK: 'uncheck',
      EXPAND: 'expand',
      COLLAPSE: 'collapse',
      SCROLL: 'scroll',
      SCROLL_TO: 'scroll-to',
    };
    const args = [command[candidate.operation], expected.ref];
    if (candidate.operation === 'DOUBLE_CLICK') {
      if (!allowPhysical) throw new Error('Pointer actions are disabled for this task.');
      args.unshift('--headed');
    }
    if (['SET_VALUE', 'TYPE'].includes(candidate.operation)) args.push('--stdin');
    if (candidate.operation === 'SELECT') {
      if (text === undefined) throw new Error('Missing selection input.');
      args.push(text);
    }
    if (candidate.operation === 'SCROLL') args.push('--direction', candidate.direction!, '--amount', '3');
    signal.throwIfAborted();
    const verifier = new ActionVerifier(this.run.bind(this));
    const verified = await verifier.execute(candidate, expected, text, args, signal);
    this.lastAction = verified.report;
    const result = verified.result;
    // A newly created window takes priority. Never silently choose between multiple new windows.
    let after = await windowsAfter();
    if (!after) return { app: context.app, surface: 'window' };
    let fresh = after.filter((w: any) => !observation.windows.some((old) => old.id === w.id));
    // Suggestions may be published shortly after the field value changes.
    const settleUntil = Date.now() + 400;
    while (
      ['SET_VALUE', 'TYPE'].includes(candidate.operation) &&
      verified.report.delivery !== 'not_delivered' &&
      fresh.length === 0 &&
      Date.now() < settleUntil
    ) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 75));
      after = (await windowsAfter()) ?? after;
      fresh = after.filter((w: any) => !observation.windows.some((old) => old.id === w.id));
    }
    const focusedNew = fresh.filter((w: any) => w.is_focused);
    if (
      fresh.length === 1 &&
      fresh[0].accessible === true &&
      ['SET_VALUE', 'TYPE'].includes(candidate.operation)
    ) {
      return { app: context.app, windowId: fresh[0].id, surface: 'window' };
    }
    const overlay = reportedOverlay(result);
    if (focusedNew.length === 1 || overlay)
      return {
        app: context.app,
        windowId: focusedNew.length === 1 ? focusedNew[0].id : context.windowId,
        surface: overlay,
      };
    // Re-read the same selected region when it still exists; observe handles stale
    // region refs by returning to a fresh top level without repeating the action.
    return context;
  }
}
