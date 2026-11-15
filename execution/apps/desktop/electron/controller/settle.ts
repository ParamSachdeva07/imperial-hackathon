import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopContext, DesktopObservation } from '../../../../packages/contracts/src/index';
import type { ObserveOptions, WorkspaceBridge } from '../desktop/workspace';
import { ObservationIndex } from './observation-index';

/** `changed` is false when nothing observable differed from `before` within the cap. */
export type Settled = { observation: DesktopObservation; index: ObservationIndex; reads: number; changed: boolean; ms: number };
export const contentKey = (index: { viewKey(): string; facts(): string[] }) => index.viewKey() + '\n' + index.facts().join('\n');
export const pageContentKey = (index: ObservationIndex) => JSON.stringify(index.nodes
  .filter(n => n.kind === 'element' && !['webarea', 'video', 'audio', 'slider'].includes(n.role))
  .map(n => [n.role, n.label, n.value, n.states.filter(s => s !== 'focused')]));

/**
 * After an action, read until the screen differs from what it showed before, or the cap
 * passes. Waiting for the interface is the controller's job, not a choice the model makes.
 * Native reads return on the first change. Browser navigation additionally waits for body
 * content: a SPA can change its URL before replacing the old page's controls.
 */
export async function settle(bridge: WorkspaceBridge, context: DesktopContext, signal: AbortSignal,
  makeIndex: (observation: DesktopObservation) => ObservationIndex, before: string,
  options: ObserveOptions & { intervalMs?: number; capMs?: number; beforePage?: { url: string; content: string } } = {}): Promise<Settled> {
  const { intervalMs = 150, capMs = 2000, beforePage, ...observe } = options;
  const started = Date.now();
  let observation = await bridge.observe(context, signal, observe);
  let index = makeIndex(observation);
  let reads = 1;
  const pendingPage = () => beforePage && observation.context.driver === 'browser' &&
    observation.snapshots[0]?.tree?.value !== beforePage.url && pageContentKey(index) === beforePage.content;
  while ((contentKey(index) === before || pendingPage()) && Date.now() - started < capMs) {
    await delay(intervalMs, undefined, { signal });
    observation = await bridge.observe(observation.context, signal, observe);
    index = makeIndex(observation);
    reads++;
  }
  if (pendingPage()) observation.notices.push('Navigation is pending: the URL changed but the previous page content is still visible. Wait and re-read before selecting a result.');
  return { observation, index, reads, changed: contentKey(index) !== before, ms: Date.now() - started };
}
