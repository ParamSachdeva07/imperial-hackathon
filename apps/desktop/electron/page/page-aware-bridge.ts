import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesktopCandidate, DesktopContext, DesktopObservation } from '../../../../packages/contracts/src/index';
import type { ObserveOptions, WorkspaceBridge } from '../desktop/workspace';
import { PageWorkspace } from './page-workspace';

const CHROME = { name: 'Google Chrome', bundle: 'com.google.chrome' };
const isChrome = (app?: string) => !!app && (app === CHROME.name || app.toLowerCase() === CHROME.bundle);

/**
 * Everything goes through accessibility except the content of a Chrome tab, which is read and
 * operated through the extension when it is connected. The browser's own toolbar, tab strip and
 * menus stay on accessibility, and so does every page the extension cannot reach.
 */
export class PageAwareBridge implements WorkspaceBridge {
  private pageWasLast = false;
  constructor(private native: WorkspaceBridge, private page: PageWorkspace,
    private defaultBrowser: () => Promise<string | undefined> = async () => undefined,
    private activate: (bundle: string) => Promise<unknown> = bundle => promisify(execFile)('/usr/bin/open', ['-b', bundle], { timeout: 5000 })) {}

  applications(signal?: AbortSignal) { return this.native.applications(signal); }
  windowInventory(app: string, signal?: AbortSignal) { return this.native.windowInventory?.(app, signal) ?? Promise.resolve([]); }
  probe(ref: string, property: 'states' | 'bounds', signal?: AbortSignal) { return this.native.probe!(ref, property, signal); }
  takeActionReport() { return this.pageWasLast ? this.page.takeActionReport() : this.native.takeActionReport?.(); }

  async observe(context: DesktopContext, signal?: AbortSignal, options?: ObserveOptions): Promise<DesktopObservation> {
    const page = this.page.connected && isChrome(context.app) && context.driver !== 'native' &&
      (context.driver === 'browser' || (!context.surface && !context.rootRef && !context.appSearch));
    if (page) {
      try { return await this.page.observe(CHROME.name, await this.native.applications(signal), signal, options?.query); }
      catch { signal?.throwIfAborted(); /* A browser page or a lost connection: read it the ordinary way. */ }
    }
    const { driver: _driver, ...rest } = context;
    const observation = await this.native.observe(rest, signal, options);
    if (this.page.connected && isChrome(observation.context.app)) observation.pageBridge = true;
    return observation;
  }

  async act(candidate: DesktopCandidate, observation: DesktopObservation, text: string | undefined,
    allowPhysical: boolean, signal: AbortSignal): Promise<DesktopContext> {
    this.pageWasLast = observation.context.driver === 'browser';
    if (this.pageWasLast) return this.page.act(candidate, observation, text, signal);
    return this.native.act(candidate, observation, text, allowPhysical, signal);
  }

  async openUrl(url: string, signal: AbortSignal): Promise<DesktopContext> {
    // The extension is used only when Chrome is where this user's links open anyway.
    if (this.page.connected && (await this.defaultBrowser().catch(() => undefined))?.toLowerCase() === CHROME.bundle) {
      this.pageWasLast = true;
      const context = await this.page.openUrl(url, CHROME.name, signal);
      await this.activate(CHROME.bundle).catch(() => undefined);
      return context;
    }
    this.pageWasLast = false;
    if (!this.native.openUrl) throw new Error('Opening an address directly is not available.');
    return this.native.openUrl(url, signal);
  }
}
