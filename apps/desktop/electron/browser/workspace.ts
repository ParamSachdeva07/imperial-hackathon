import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopCandidate, DesktopContext, DesktopObservation } from '../../../../packages/contracts/src/index';
import type { ActionReport } from '../desktop/action-verification';
import { NativeError } from '../desktop/native-client';
import type { BrowserClient } from './client';
import { browserObservation, type BrowserCapture } from './observation';
import { ACTIVE_HTML, PAGE_STATE, PAGE_IDENTITY, evaluation } from './page-state';

export class BrowserWorkspace {
  private ready = false;
  private lastAction?: ActionReport;
  private transition?: { url: string; documentId: string; contentKey: string; started: number };
  constructor(readonly client: BrowserClient) {}
  takeActionReport() { const report = this.lastAction; this.lastAction = undefined; return report; }
  async capture(signal?: AbortSignal): Promise<BrowserCapture> {
    if (!this.ready) {
      await this.client.run(['open', 'about:blank'], signal);
      this.ready = true;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const beforeTabs = await this.client.run(['tab', 'list'], signal);
      const before = evaluation(await this.client.run(['eval', '(' + PAGE_IDENTITY + ')()'], signal));
      const snapshot = await this.client.run(['snapshot', '-i', '-u'], signal);
      const page = evaluation(await this.client.run(['eval', '(' + PAGE_STATE + ')()'], signal));
      const { tabs } = await this.client.run(['tab', 'list'], signal);
      if (beforeTabs.tabs.find((t: any) => t.active)?.tabId === tabs.find((t: any) => t.active)?.tabId &&
        before.documentId === page.documentId && before.url === page.url) {
        const prior = this.transition;
        if (prior && (prior.documentId !== page.documentId || prior.contentKey !== page.contentKey)) this.transition = undefined;
        else if (prior && prior.url !== page.url) {
          if (Date.now() - prior.started > 15_000)
            throw new Error('The browser URL changed but its main content did not update. Observe the page before continuing; the previous action will not be repeated.');
          if (attempt < 2) { await delay(300, undefined, { signal }); continue; }
          page.contentPending = true;
          page.busy = true;
        }
        return { snapshot, page, tabs };
      }
    }
    throw new NativeError('STALE_REF', 'Browser kept navigating during observation.', {delivery:'not_delivered',retry:'safe'});
  }
  async observe(context: DesktopContext, applications: DesktopObservation['applications'], signal?: AbortSignal) {
    const capture = await this.capture(signal);
    return browserObservation(capture, context.app || 'Google Chrome', applications);
  }
  async act(candidate: DesktopCandidate, observation: DesktopObservation, text: string | undefined, signal: AbortSignal): Promise<DesktopContext> {
    this.lastAction = undefined;
    const snapshot = observation.snapshots.find(s => s.id === candidate.snapshotId);
    if (!snapshot?.browser) throw new Error('Browser action has no matching page observation.');
    if (candidate.app !== snapshot.app || candidate.app !== observation.context.app ||
      snapshot.windowId !== observation.context.windowId ||
      (candidate.operation !== 'READ_WINDOW' && candidate.windowId !== snapshot.windowId))
      throw new Error('Browser action does not belong to the observed app and tab.');
    const expected = snapshot.browser;
    const fresh = await this.capture(signal);
    const currentTab = fresh.tabs.find(t => t.active);
    const stale = (message: string): never => { throw new NativeError('STALE_REF', message, { delivery: 'not_delivered', retry: 'safe' }); };
    if (currentTab?.tabId !== expected.tabId || fresh.page.documentId !== expected.documentId || fresh.page.url !== expected.url)
      stale('The browser page changed before dispatch; select again from its fresh state.');
    if (fresh.page.contentPending && candidate.operation !== 'WAIT')
      stale('The browser is still showing content from its previous URL. Wait for the new content before acting.');
    let ref: string | undefined;
    let target = snapshot.elements.find(e => e.ref === candidate.targetRef);
    if (candidate.targetRef) {
      if (!target?.nativeId) throw new Error('Browser target is outside its snapshot.');
      ref = '@' + target.nativeId;
      const now = fresh.snapshot.refs?.[target.nativeId];
      const role = now?.role === 'textbox' ? 'textfield' : now?.role;
      if (!now || now.name !== target.name || role !== target.role) stale('Browser target changed before dispatch.');
    }
    const report: ActionReport = { operation: candidate.operation, target: candidate.name, delivery: 'delivered_unverified', verification: 'unverified' };
    if (candidate.operation === 'SET_VALUE') {
      if (!ref || !target || text === undefined) throw new Error('Fill requires an observed field and supplied text.');
      const before = await this.client.run(['get', 'value', ref], signal);
      const value = typeof before === 'string' ? before : before.value;
      if (value !== target.value) stale('The page field was edited since observation.');
      if (value === text) {
        this.lastAction = { ...report, delivery: 'not_delivered', verification: 'already_satisfied', expectedValue: text, observedValue: text };
        return observation.context;
      }
      await this.client.run(['focus', ref], signal);
      const html = await this.client.run(['get', 'html', ref], signal);
      const active = evaluation(await this.client.run(['eval', '(' + ACTIVE_HTML + ')()'], signal));
      const targetHtml = typeof html === 'string' ? html : html.html;
      // get html may return innerHTML; focus is additionally checked by the native fill
      // target and exact value read-back. For outerHTML, prove the active editor too.
      if (targetHtml?.startsWith('<') && targetHtml === targetHtml.trim() && /^(<input|<textarea)/i.test(targetHtml) && targetHtml !== active)
        stale('The observed browser editor did not receive focus.');
      signal.throwIfAborted();
      await this.client.run(['fill', ref, text]);
      const after = await this.client.run(['get', 'value', ref]);
      const observed = typeof after === 'string' ? after : after.value;
      if (observed !== text) throw new Error('Browser text was dispatched but its exact value was not verified. It will not be repeated.');
      this.lastAction = { ...report, verification: 'verified', expectedValue: text, observedValue: observed };
      return observation.context;
    }
    let args: string[];
    switch (candidate.operation) {
      case 'NAVIGATE':
        if (!text?.trim() || /\s/.test(text) || (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^https?:/i.test(text)))
          throw new Error('Navigation requires the supplied HTTP(S) website address.');
        args = ['open', text]; break;
      case 'CLICK': case 'FOCUS': case 'CHECK': case 'UNCHECK':
        if (!ref) throw new Error('This browser action needs an observed target.');
        args = [candidate.operation.toLowerCase(), ref]; break;
      case 'PRESS':
        if (!['Enter', 'Escape', 'Tab', 'Shift+Tab', 'Space', 'ArrowDown', 'ArrowUp'].includes(candidate.key || '')) throw new Error('Unsupported browser key.');
        args = ['press', candidate.key!]; break;
      case 'SCROLL': args = ['scroll', candidate.direction!, '600']; break;
      case 'BACK': case 'FORWARD': args = [candidate.operation.toLowerCase()]; break;
      case 'READ_WINDOW':
        if (!observation.windows.some(w => w.id === candidate.windowId)) throw new Error('Tab was not observed.');
        args = ['tab', candidate.windowId!]; break;
      case 'WAIT':
        await delay(300, undefined, { signal });
        this.lastAction = { ...report, delivery: 'not_delivered' };
        return observation.context;
      default: throw new Error('Unsupported browser operation ' + candidate.operation);
    }
    signal.throwIfAborted();
    await this.client.run(args);
    if (['NAVIGATE', 'CLICK', 'PRESS', 'BACK', 'FORWARD'].includes(candidate.operation) && fresh.page.contentKey)
      this.transition = { url: fresh.page.url, documentId: fresh.page.documentId, contentKey: fresh.page.contentKey, started: Date.now() };
    this.lastAction = report;
    return { ...observation.context, windowId: candidate.operation === 'READ_WINDOW' ? candidate.windowId : expected.tabId };
  }
}
