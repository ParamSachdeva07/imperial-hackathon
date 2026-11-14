import { afterEach, expect, it, vi } from 'vitest';
import { HybridWorkspaceBridge } from '../apps/desktop/electron/desktop/hybrid-workspace';
import { desktopCandidates } from '../apps/desktop/electron/controller/desktop-candidates';
import { TaskInputSchema, type DesktopObservation } from '../packages/contracts/src/index';
import type { WorkspaceBridge } from '../apps/desktop/electron/desktop/workspace';
import type { BrowserWorkspace } from '../apps/desktop/electron/browser/workspace';

afterEach(() => vi.unstubAllEnvs());
const observation = {
  id: 'o1', capturedAt: 1, context: { app: 'Google Chrome' }, applications: [], windows: [], snapshots: [], notices: [],
} as DesktopObservation;
const task = TaskInputSchema.parse({ provider: 'jev', goal: 'Read this browser page' });

it('native mode never offers a debugger route and observes Chrome through Accessibility', async () => {
  vi.stubEnv('ASSISTANT_BROWSER_DRIVER', 'native');
  const native = { observe: vi.fn().mockResolvedValue(observation), applications: vi.fn() } as unknown as WorkspaceBridge;
  const browser = { observe: vi.fn() } as unknown as BrowserWorkspace;
  const bridge = new HybridWorkspaceBridge(native, browser);
  expect(await bridge.observe({ app: 'Google Chrome' })).toBe(observation);
  expect(browser.observe).not.toHaveBeenCalled();
  expect(desktopCandidates(observation, task).some(c => c.operation === 'READ_BROWSER')).toBe(false);
});

it('legacy adapter can be tested in isolation but production never offers a debugger route', async () => {
  vi.stubEnv('ASSISTANT_BROWSER_DRIVER', 'browser');
  const native = { observe: vi.fn(), applications: vi.fn().mockResolvedValue([]) } as unknown as WorkspaceBridge;
  const browser = { observe: vi.fn().mockResolvedValue(observation) } as unknown as BrowserWorkspace;
  const bridge = new HybridWorkspaceBridge(native, browser);
  expect(await bridge.observe({ app: 'Google Chrome' })).toBe(observation);
  expect(native.observe).not.toHaveBeenCalled();
  expect(desktopCandidates(observation, task).some(c => c.operation === 'READ_BROWSER')).toBe(false);
});
