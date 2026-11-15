import type { WorkspaceBridge } from '../../desktop/workspace';
import { ObservationIndex, type IndexedNode } from './observation-index';

/**
 * The menu bar is an application's own labelled command inventory. Read it once per app,
 * keep it, and let its items be retrieved like any other control.
 *
 * The native helper does not report key equivalents (snapshot nodes carry name, role,
 * states and actions only), so shortcuts cannot be discovered here yet.
 */
export class MenuIndex {
  private cache = new Map<string, { nodes: IndexedNode[]; at: number }>();
  constructor(private maxAgeMs = 60_000) {}

  invalidate(app?: string) {
    if (app) this.cache.delete(app); else this.cache.clear();
  }

  async nodes(app: string, bridge: WorkspaceBridge, signal: AbortSignal, maxAgeMs = this.maxAgeMs): Promise<IndexedNode[]> {
    const cached = this.cache.get(app);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.nodes;
    let nodes: IndexedNode[] = [];
    try {
      const observation = await bridge.observe({ app, surface: 'menubar' }, signal, { startDepth: 6 });
      const index = new ObservationIndex(observation, { prefix: 'm', kind: 'menu' });
      nodes = index.nodes.filter(n => n.role === 'menuitem' && n.identity.label && n.operations.length)
        .map(n => ({ ...n, path: ['Menu bar', ...n.path] }));
    } catch (error) {
      // The menu bar is an optimisation. A failed read must never fail the task.
      signal.throwIfAborted();
    }
    this.cache.set(app, { nodes, at: Date.now() });
    return nodes;
  }
}
