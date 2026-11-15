import { expect, it } from 'vitest';
import { ObservationIndex } from '../apps/desktop/electron/controller/v2/observation-index';
import { contentKey, pageContentKey, settle } from '../apps/desktop/electron/controller/v2/settle';
import type { DesktopObservation } from '../packages/contracts/src/index';
import type { WorkspaceBridge } from '../apps/desktop/electron/desktop/workspace';

function page(url: string, label: string): DesktopObservation {
  const link = { id: 'link', ref: 'link', role: 'link', name: label, value: '', states: [], actions: ['Click'], children: [] };
  return { id: url + label, capturedAt: 1, context: { app: 'Browser', driver: 'browser' }, windows: [], applications: [], notices: [],
    snapshots: [{ id: 's', app: 'Browser', windowId: 'tab', windowTitle: 'Page', surface: 'window', complete: true, capturedAt: 1,
      tree: { id: 'root', role: 'webarea', name: 'Page', value: url, states: [], actions: [], children: [link] }, elements: [link] }] };
}

it('waits for new page content when a SPA changes URL before replacing old controls', async () => {
  const before = new ObservationIndex(page('https://example.test/a', 'Old result'));
  const observations = [page('https://example.test/b', 'Old result'), page('https://example.test/b', 'New result')];
  const bridge = { observe: async () => observations.shift()! } as unknown as WorkspaceBridge;
  const result = await settle(bridge, {}, new AbortController().signal, o => new ObservationIndex(o), contentKey(before),
    { intervalMs: 1, beforePage: { url: 'https://example.test/a', content: pageContentKey(before) } });
  expect(result.reads).toBe(2);
  expect(result.index.nodes.some(n => n.label === 'New result')).toBe(true);
});

it('reports pending navigation when the URL changes but the old body persists past the cap', async () => {
  const before = new ObservationIndex(page('https://example.test/a', 'Old result'));
  const bridge = { observe: async () => page('https://example.test/b', 'Old result') } as unknown as WorkspaceBridge;
  const result = await settle(bridge, {}, new AbortController().signal, o => new ObservationIndex(o), contentKey(before),
    { capMs: 0, beforePage: { url: 'https://example.test/a', content: pageContentKey(before) } });
  expect(result.observation.notices.join(' ')).toContain('Navigation is pending');
});
