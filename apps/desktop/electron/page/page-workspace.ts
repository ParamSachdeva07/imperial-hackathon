import { randomUUID } from 'node:crypto';
import type {
  AccessibilityNode, Application, DesktopCandidate, DesktopContext, DesktopObservation, Element,
} from '../../../../packages/contracts/src/index';
import type { ActionReport } from '../desktop/action-verification';
import { NativeError } from '../desktop/native-client';
import { PageBridgeError, type PageBridgeServer } from './page-bridge-server';

type PageNode = { id: number; role: string; name: string; value?: string; states?: string[]; actions?: string[];
  bounds?: { x: number; y: number; width: number; height: number }; children?: PageNode[] };
type PageReply = { tab: { id: number; url: string; title: string; status?: string }; tabs?: { id: number; title: string; url: string; active: boolean }[];
  restricted?: boolean; reason?: string;
  page?: { document: string; url: string; title: string; readyState: string; nodes: PageNode; count: number; truncated: boolean; frames: number; ms: number } };
/** `dispatched` says whether anything reached the page; `verified` says what was seen afterwards. They are never inferred from each other. */
type ActReply = { dispatched: boolean; already?: boolean; verified?: boolean; expectedValue?: string; observedValue?: string; code?: string; message?: string };

/** Raised when the active tab cannot be read through the extension (a browser page, the web store). */
export class PageUnavailable extends Error {}

const OPERATIONS: Partial<Record<DesktopCandidate['operation'], string>> = {
  CLICK: 'click', FOCUS: 'focus', SET_VALUE: 'setValue', TYPE: 'type', SELECT: 'select', CHECK: 'check', UNCHECK: 'uncheck',
  SCROLL_TO: 'scrollTo', SCROLL: 'scroll', PRESS: 'press',
};
export const PAGE_KEYS = ['return', 'escape'];

/** A web page as an observation: read from its own DOM in milliseconds, acted on through the extension. */
export class PageWorkspace {
  private revision = 0;
  private documents = new Map<string, { tabId: number; document: string }>();
  private lastAction?: ActionReport;
  constructor(private server: PageBridgeServer) {}
  get connected() { return this.server.connected; }
  takeActionReport() { const report = this.lastAction; this.lastAction = undefined; return report; }

  /** `query` lets the page list matching controls that lie beyond its size limit. */
  async observe(app: string, applications: Application[], signal?: AbortSignal, query = ''): Promise<DesktopObservation> {
    const reply = await this.server.send<PageReply>('snapshot', { query: query.slice(0, 300) }, 5000, signal);
    if (reply.restricted || !reply.page) throw new PageUnavailable(reply.reason || 'This tab cannot be read by the extension.');
    const page = reply.page;
    const snapshotId = 'p' + (++this.revision).toString(36);
    this.documents.set(snapshotId, { tabId: reply.tab.id, document: page.document });
    if (this.documents.size > 20) this.documents.delete(this.documents.keys().next().value!);
    const elements: Element[] = [];
    const convert = (node: PageNode, id: string, path: string[]): AccessibilityNode => {
      const ref = node.id ? '@' + snapshotId + ':e' + node.id : undefined;
      // Element numbers restart in every document, so the identity names the tab and document too:
      // two "Continue" buttons on different pages are different controls.
      const nativeId = node.id ? reply.tab.id + ':' + page.document + ':' + node.id : undefined;
      const converted: AccessibilityNode = {
        id, ref, role: node.role, name: node.name || '', value: node.value || '', states: node.states || [], actions: node.actions || [],
        bounds: node.bounds, nativeId, nativeIdKind: node.id ? 'dom' : undefined,
        children: (node.children || []).map((child, index) => convert(child, id + '_' + index, [...path, node.name || node.role].slice(-5))),
      };
      if (ref) elements.push({ ref, role: converted.role, name: converted.name, value: converted.value, actions: converted.actions,
        states: converted.states, bounds: converted.bounds, nativeId, nativeIdKind: 'dom', path: path.join(' > ') });
      return converted;
    };
    const tree = convert(page.nodes, 'n0', []);
    const notices = ['Page address: ' + page.url];
    if (page.truncated) notices.push('This page is very large: the first ' + page.count + ' items are listed, plus anything further down that matches the current search. Use find with other words to look for something else.');
    if (page.frames) notices.push(page.frames + ' embedded frame(s) on this page were not read.');
    if (page.readyState !== 'complete') notices.push('The page is still loading.');
    const others = (reply.tabs || []).filter(tab => !tab.active).slice(0, 12).map(tab => JSON.stringify(tab.title.slice(0, 60)));
    if (others.length) notices.push('Other tabs in this window: ' + others.join(', ') + '.');
    return {
      id: randomUUID(), capturedAt: Date.now(), context: { driver: 'browser', app }, applications, windows: [], notices,
      snapshots: [{ id: snapshotId, app, windowId: '', windowTitle: page.title, surface: 'page', complete: true,
        capturedAt: Date.now(), elements, tree }],
    };
  }

  async act(candidate: DesktopCandidate, observation: DesktopObservation, text: string | undefined, signal: AbortSignal): Promise<DesktopContext> {
    this.lastAction = undefined;
    const operation = OPERATIONS[candidate.operation];
    if (!operation) throw new Error(candidate.operation + ' is not available on a web page.');
    const snapshot = observation.snapshots.find(s => s.id === candidate.snapshotId);
    const element = snapshot?.elements.find(e => e.ref === candidate.targetRef);
    const source = snapshot && this.documents.get(snapshot.id);
    if (!snapshot || !source || (candidate.operation !== 'PRESS' && candidate.operation !== 'SCROLL' && !element))
      throw new Error('Action target is outside its page snapshot.');
    if (candidate.operation === 'PRESS' && !PAGE_KEYS.includes(candidate.key || '')) throw new Error('That key is not available on a web page.');
    // Return submits whatever has focus, so it must name the field it is meant for.
    if (candidate.operation === 'PRESS' && candidate.key === 'return' && !element) throw new Error('Return needs the field it is meant for.');
    const argument = candidate.operation === 'PRESS' ? candidate.key : candidate.operation === 'SCROLL' ? candidate.direction : text;
    if (['SET_VALUE', 'TYPE', 'SELECT'].includes(candidate.operation) && argument === undefined) throw new Error('Missing text input.');
    signal.throwIfAborted();
    const reply = await this.command<ActReply>('act', { tabId: source.tabId, document: source.document,
      element: element ? Number(element.ref.slice(element.ref.lastIndexOf(':e') + 2)) : 0, operation, argument,
      requireFocus: candidate.operation === 'PRESS' && !!element }, 8000);
    const context: DesktopContext = { driver: 'browser', app: observation.context.app };
    if (reply?.already) {
      this.lastAction = { operation: candidate.operation, target: candidate.name, delivery: 'not_delivered', verification: 'already_satisfied' };
      return context;
    }
    if (!reply?.dispatched) throw new NativeError(reply?.code || 'PAGE_ACTION', reply?.message || 'The page could not do that.',
      { delivery: 'not_delivered', retry: 'inspect' });
    const expected = candidate.operation === 'SET_VALUE' ? text : candidate.operation === 'TYPE' ? reply.expectedValue : undefined;
    const verified = expected !== undefined ? reply.observedValue === expected : reply.verified === true;
    this.lastAction = { operation: candidate.operation, target: candidate.name, delivery: 'delivered',
      verification: verified ? 'verified' : 'unverified', expectedValue: expected, observedValue: reply.observedValue };
    return context;
  }

  /**
   * Only two failures prove nothing was sent: the extension was not connected, or it refused
   * before touching the page. Anything else, a lost or late reply included, may have run.
   */
  private async command<T>(type: string, payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    try { return await this.server.send<T>(type, payload, timeoutMs, signal); }
    catch (error) {
      signal?.throwIfAborted();
      const message = (error as Error).message;
      if (error instanceof PageBridgeError && /not connected|active tab changed|Only http and https/.test(message))
        throw new NativeError('STALE_REF', message, { delivery: 'not_delivered', retry: 'safe' });
      throw new NativeError('PAGE_ACTION', message + ' It may still have taken effect.', { delivery: 'unknown', retry: 'inspect' });
    }
  }

  async openUrl(url: string, app: string, signal: AbortSignal): Promise<DesktopContext> {
    await this.command('open_url', { url, newTab: true, waitMs: 6000 }, 9000, signal);
    return { driver: 'browser', app };
  }

  /** The browser's default search engine, so no results address is ever constructed. */
  async searchWeb(text: string, app: string, signal: AbortSignal): Promise<DesktopContext> {
    await this.command('search', { text: text.slice(0, 500), waitMs: 6000 }, 9000, signal);
    return { driver: 'browser', app };
  }
}
