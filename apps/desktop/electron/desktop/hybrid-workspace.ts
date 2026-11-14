import { existsSync } from 'node:fs';
import type { DesktopCandidate, DesktopContext, DesktopObservation } from '../../../../packages/contracts/src/index';
import type { WorkspaceBridge } from './workspace';
import { BrowserWorkspace } from '../browser/workspace';

// These identify browser runtimes, not websites or task-specific controls.
const chromiumApps = new Set(['Google Chrome', 'com.google.Chrome']);
export function isBrowserApplication(app?: string) { return !!app && chromiumApps.has(app); }
export function usesBrowserAdapter(app?: string) {
  return process.env.ASSISTANT_BROWSER_DRIVER !== 'native' && isBrowserApplication(app);
}
export function installedChrome(): string | undefined {
  const configured = process.env.ASSISTANT_BROWSER_EXECUTABLE;
  if (configured) return configured;
  const paths = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32' ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'] : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  return paths.find(p => existsSync(p));
}

export class HybridWorkspaceBridge implements WorkspaceBridge {
  private lastDriver: 'native' | 'browser' = 'native';
  constructor(private native: WorkspaceBridge, readonly browser: BrowserWorkspace) {}
  applications(signal?: AbortSignal) { return this.native.applications(signal); }
  takeActionReport() { return this.lastDriver === 'browser' ? this.browser.takeActionReport() : this.native.takeActionReport?.(); }
  async observe(context: DesktopContext, signal?: AbortSignal): Promise<DesktopObservation> {
    if (usesBrowserAdapter(context.app) && (context.driver === 'browser' || (!context.driver && !context.surface && !context.rootRef)))
      return this.browser.observe(context, await this.applications(signal), signal);
    return this.native.observe(context, signal);
  }
  async act(candidate: DesktopCandidate, observation: DesktopObservation, text: string | undefined,
    allowPhysical: boolean, signal: AbortSignal): Promise<DesktopContext> {
    if (candidate.operation === 'OPEN_APP' && usesBrowserAdapter(candidate.app)) {
      if (!observation.applications.some(a => a.id === candidate.app || a.name === candidate.app)) throw new Error('Browser app was not observed.');
      this.lastDriver = 'browser';
      return { driver: 'browser', app: 'Google Chrome' };
    }
    if (candidate.operation === 'READ_BROWSER') {
      if (!usesBrowserAdapter(observation.context.app)) throw new Error('Browser debugging adapter is disabled or unsupported for this application.');
      return { driver: 'browser', app: observation.context.app };
    }
    if (observation.context.driver === 'browser') {
      if (candidate.operation === 'OPEN_APP') {
        this.lastDriver = 'native';
        return this.native.act(candidate, observation, text, allowPhysical, signal);
      }
      if (candidate.operation === 'READ_SURFACE') {
        this.lastDriver = 'native';
        return { driver: 'native', app: observation.context.app, surface: candidate.surface };
      }
      this.lastDriver = 'browser';
      return this.browser.act(candidate, observation, text, signal);
    }
    this.lastDriver = 'native';
    const next = await this.native.act(candidate, observation, text, allowPhysical, signal);
    return { ...next, driver: 'native' };
  }
}
