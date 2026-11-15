import type {
  AccessibilityNode, DesktopObservation, Element, PlanElement, PlanOperation, Scope, Snapshot,
} from '../../../../packages/contracts/src/index';
import { canFocusAndPaste } from '../desktop/focus-and-paste';
import { atLeast, matchIdentity, type ElementIdentity, type Match } from './identity';
import { clip } from './text';

export type IndexedNode = {
  id: string;
  kind: 'element' | 'application' | 'window' | 'menu';
  role: string;
  label: string;
  value: string;
  description: string;
  states: string[];
  /** Labels of the ancestors, outermost first. */
  path: string[];
  identity: ElementIdentity;
  operations: PlanOperation[];
  depth: number;
  unread: number;
  lowInformation: boolean;
  inModal: boolean;
  /** The observation whose refs this node belongs to. Menu items come from a cached menu bar read. */
  owner: DesktopObservation;
  snapshot?: Snapshot;
  element?: Element;
  appId?: string;
  windowId?: string;
};
export type Selection = { elements: PlanElement[]; scopes: Scope[] };
export type SelectOptions = {
  query: string;
  requirementTerms: string[];
  pinned: ElementIdentity[];
  previous?: { viewKey: string; facts: string[] };
  extra?: IndexedNode[];
  retrieve?: number;
  limit?: number;
};

export const MAX_ELEMENTS = 100;
export const RETRIEVE = 40;
// Used only to annotate the outline. Never to remove or restrict a control.
const REGION_ROLES = new Set(['toolbar', 'menu', 'menubar', 'list', 'table', 'outline', 'tablist', 'banner', 'main',
  'navigation', 'search', 'complementary', 'contentinfo', 'region', 'webarea', 'scrollarea', 'sheet', 'dialog', 'popover']);

const factOf = (node: IndexedNode) => JSON.stringify([node.role, clip(node.identity.label, 250), clip(node.value, 400),
  node.states.filter(s => s !== 'focused').sort(), node.unread]);
const tokens = (text: string): string[] => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Offered operations follow reported actions and explicit states only, never a role guess. */
export function operationsFor(element: Element, complete: boolean, allowPhysical: boolean): PlanOperation[] {
  if (!complete || element.states.includes('hidden')) return [];
  // Some native editors report AXEnabled=false while holding verified keyboard focus. The
  // generic paste helper explicitly supports that case and rechecks focus before dispatch.
  // Do not advertise ordinary AX actions on disabled controls.
  if (element.states.includes('disabled')) return canFocusAndPaste(element) ? ['FOCUS_AND_PASTE'] : [];
  const has = (...actions: string[]) => actions.some(action => element.actions.includes(action));
  const result: PlanOperation[] = [];
  if (has('Click')) result.push('CLICK');
  if (has('Click') && allowPhysical) result.push('DOUBLE_CLICK');
  if (has('RightClick', 'ShowMenu')) result.push('RIGHT_CLICK');
  if (has('SetFocus') && !element.states.includes('focused')) result.push('FOCUS');
  if (has('Expand')) result.push('EXPAND');
  if (has('Collapse')) result.push('COLLAPSE');
  if (has('Toggle', 'Check')) result.push('CHECK');
  if (has('Toggle', 'Uncheck')) result.push('UNCHECK');
  if (!element.states.includes('readonly')) {
    if (has('SetValue')) result.push('SET_VALUE');
    if (has('Type', 'TypeText')) result.push('TYPE');
    if (canFocusAndPaste(element)) result.push('FOCUS_AND_PASTE');
  }
  if (has('Select')) result.push('SELECT');
  if (has('Scroll')) result.push('SCROLL');
  if (has('ScrollTo')) result.push('SCROLL_TO');
  return result;
}

export function difference(left: string[], right: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of right) counts.set(item, (counts.get(item) || 0) + 1);
  return left.filter(item => {
    const count = counts.get(item) || 0;
    if (!count) return true;
    counts.set(item, count - 1);
    return false;
  });
}

/** Everything read from one observation, addressable at any depth. */
export class ObservationIndex {
  readonly nodes: IndexedNode[] = [];
  private byId = new Map<string, IndexedNode>();
  private outlineLines: string[] = [];
  readonly snapshot?: Snapshot;

  constructor(readonly observation: DesktopObservation,
    private options: { allowPhysical?: boolean; prefix?: string; kind?: 'element' | 'menu' } = {}) {
    this.snapshot = observation.snapshots[0];
    if (this.snapshot) this.indexSnapshot(this.snapshot);
    if ((options.kind ?? 'element') === 'element') this.indexInventory();
    for (const node of this.nodes) this.byId.set(node.id, node);
  }

  private indexSnapshot(snapshot: Snapshot) {
    const prefix = this.options.prefix ?? 'e';
    const kind = this.options.kind ?? 'element';
    const elements = new Map(snapshot.elements.map(e => [e.ref, e]));
    const root: AccessibilityNode = snapshot.tree ?? { id: 'root', role: 'window', name: snapshot.windowTitle, value: '',
      states: [], actions: [], children: snapshot.elements.map((e, i) => ({ ...e, id: 'element_' + i, children: [] })) };
    // A read scoped to a region knows where that region sits in the window, so its elements keep
    // the identities they have in a full read. Only a root of unknown position is a wildcard.
    const context = this.observation.context;
    const anchor = kind === 'element' && context.rootRef ? context.scopePath?.at(-1)?.anchor : undefined;
    const visit = (node: AccessibilityNode, ancestors: AccessibilityNode[], siblings: AccessibilityNode[], inModal: boolean, trail: string[]): number => {
      if (node.states.includes('hidden')) return 0;
      const ownLabel = node.name || node.description || '';
      const element = node.ref ? elements.get(node.ref) ?? { ...node, ref: node.ref } : undefined;
      // Pasting through the clipboard is a native operation; a web page takes text directly.
      const operations = (element ? operationsFor(element, snapshot.complete, !!this.options.allowPhysical) : [])
        .filter(operation => snapshot.surface !== 'page' || !['FOCUS_AND_PASTE', 'RIGHT_CLICK', 'DOUBLE_CLICK'].includes(operation));
      const modal = inModal || node.role === 'sheet' || node.states.includes('modal');
      const sameRole = siblings.filter(s => s.role === node.role);
      let label = ownLabel;
      const lowInformation = !ownLabel && operations.length > 0;
      if (lowInformation) {
        // An unlabeled control stays selectable; describe it by what surrounds it.
        const position = siblings.indexOf(node);
        const near = [siblings[position - 1], siblings[position + 1]]
          .map(s => s && (s.name || s.description)).filter(Boolean).map(text => JSON.stringify(clip(text as string, 40)));
        const parent = ancestors.at(-1);
        label = '(unlabeled ' + node.role + (near.length ? '; next to ' + near.join(' and ') : '') +
          '; ' + (sameRole.indexOf(node) + 1) + ' of ' + sameRole.length + ' in ' +
          (parent ? parent.name || parent.description || parent.role : 'window') + ')';
      }
      const indexed: IndexedNode = {
        id: prefix + this.nodes.length, kind, role: node.role, label, value: node.value || '',
        description: node.name && node.description ? node.description : '', states: node.states,
        path: ancestors.map(a => a.name || a.description || '').filter((text, i, all) => text && text !== all[i - 1]),
        identity: { app: snapshot.app, windowId: kind === 'menu' ? undefined : snapshot.windowId || undefined, role: node.role,
          label: ownLabel, nativeId: node.nativeId ? { kind: node.nativeIdKind || '', value: node.nativeId } : undefined,
          ancestorRoles: trail, siblingIndex: !ancestors.length && anchor ? anchor.index : sameRole.indexOf(node) },
        operations, depth: ancestors.length, unread: node.childrenCount || 0, lowInformation, inModal: modal,
        owner: this.observation, snapshot, element,
      };
      this.nodes.push(indexed);
      const children = node.children.filter(child => !child.states.includes('hidden'));
      let controls = operations.length ? 1 : 0;
      const line = this.outlineLines.push('') - 1;
      // The root of this read may be a region of a larger tree, so its own position is unknown.
      const step = node.role + '#' + (ancestors.length ? sameRole.indexOf(node) : anchor ? anchor.index : '*');
      for (const child of children) controls += visit(child, [...ancestors, node], children, modal, [...trail, step]);
      const region = REGION_ROLES.has(node.role) || (!!ownLabel && children.length >= 3) || indexed.unread > 0;
      if (region && ancestors.length <= 5 && (children.length || indexed.unread))
        this.outlineLines[line] = '  '.repeat(Math.min(ancestors.length, 5)) + node.role + (ownLabel ? ' ' + JSON.stringify(clip(ownLabel, 80)) : '') +
          ' (' + controls + ' controls' + (indexed.unread ? ', ' + indexed.unread + ' unread children, scope region:' + indexed.id : '') + ')';
      else this.outlineLines.splice(line, 1);
      return controls;
    };
    visit(root, [], [root], false, anchor?.trail ?? []);
  }

  private indexInventory() {
    const context = this.observation.context;
    this.observation.windows.forEach((window, index) => this.nodes.push({
      id: 'w' + index, kind: 'window', role: 'window', label: window.title || window.id, value: '', description: '',
      states: window.focused ? ['focused'] : [], path: [window.app],
      identity: { app: window.app, windowId: window.id, role: 'os-window', label: window.title, ancestorRoles: [], siblingIndex: 0 },
      operations: window.focused && window.id === context.windowId ? [] : ['FOCUS_WINDOW'], depth: 0, unread: 0,
      lowInformation: false, inModal: false, owner: this.observation, windowId: window.id,
    }));
    this.observation.applications.forEach((app, index) => {
      if (app.name === context.app && app.running && this.observation.snapshots.length) return;
      this.nodes.push({
        id: 'a' + index, kind: 'application', role: 'application', label: app.name, value: '', description: '',
        states: app.running ? ['running'] : ['installed'], path: [],
        identity: { app: app.id, role: 'os-application', label: app.name, ancestorRoles: [], siblingIndex: 0 },
        operations: ['OPEN_APP'], depth: 0, unread: 0, lowInformation: false, inModal: false, owner: this.observation, appId: app.id,
      });
    });
  }

  get(id: string): IndexedNode | undefined { return this.byId.get(id); }
  adopt(extra: IndexedNode[]) { for (const node of extra) this.byId.set(node.id, node); }
  outline(): string[] { return this.outlineLines.slice(0, 50); }

  viewKey(): string {
    const context = this.observation.context;
    return JSON.stringify([context.app, context.windowId, context.surface || 'window', context.scopePath?.map(s => s.name) || [],
      context.appSearch || '']);
  }
  /** What was observed, without focus, geometry or refs: used for deltas and settle detection. */
  facts(): string[] {
    return [
      ...this.observation.windows.map(w => JSON.stringify(['window', w.title])),
      ...this.nodes.filter(n => n.kind === 'element' && (n.identity.label || n.value || n.unread)).map(factOf),
    ];
  }
  delta(previous: { viewKey: string; facts: string[] }) {
    const scopeChanged = previous.viewKey !== this.viewKey();
    const facts = this.facts();
    // Cross-scope child controls are incomparable, but the application window inventory is
    // global. Retain new windows so switching to a newly created document does not erase proof.
    const comparable = (rows: string[]) => scopeChanged ? rows.filter(row => row.startsWith('["window",') && JSON.parse(row).length === 2) : rows;
    return { scopeChanged, added: difference(comparable(facts), comparable(previous.facts)).slice(0, 12).map(f => clip(f, 700)),
      removed: difference(comparable(previous.facts), comparable(facts)).slice(0, 12).map(f => clip(f, 700)) };
  }
  find(identity: ElementIdentity, minimum: Match = 'strong'): IndexedNode[] {
    return this.nodes.filter(n => atLeast(matchIdentity(n.identity, identity), minimum));
  }
  focused(): IndexedNode | undefined {
    return this.nodes.find(n => n.kind === 'element' && n.states.includes('focused') && n.element);
  }

  private scopes(retrieved: IndexedNode[] = []): Scope[] {
    const context = this.observation.context;
    const scopes: Scope[] = [];
    if (context.rootRef) scopes.push({ id: 'top', label: 'Return to the top level of this window.' });
    const page = context.driver === 'browser';
    if (this.observation.pageBridge) scopes.push({ id: 'page', label: 'Read the web page in the active tab directly. Faster and more complete than the window.' });
    if (context.app) {
      for (const surface of ['window', 'menubar', 'menu', 'sheet', 'alert', 'popover', 'focused']) {
        if (page && surface !== 'window' && surface !== 'menubar') continue;
        if (!page && surface === (context.surface || 'window') && !context.rootRef) continue;
        if (!page && surface === 'window' && !context.windowId) continue;
        scopes.push({ id: 'surface:' + surface, label: page && surface === 'window'
          ? 'Read the browser window itself (tabs, toolbar, address bar) instead of the page.'
          : 'Read the ' + surface + ' surface of ' + context.app + '.' });
      }
      for (const node of this.nodes) if (node.kind === 'window' && node.windowId !== context.windowId)
        scopes.push({ id: 'window:' + node.id, label: 'Read window ' + JSON.stringify(clip(node.label, 120)) + ' without focusing it.' });
    }
    // A region the planner was shown must be one it can open: retrieved regions come first.
    const readable = (n: IndexedNode) => n.kind === 'element' && n.unread > 0 && !!n.element && n.element.ref !== context.rootRef && n.owner === this.observation;
    const regions = [...new Set([...retrieved.filter(readable), ...this.nodes.filter(readable)])].slice(0, 30);
    for (const node of regions)
      scopes.push({ id: 'region:' + node.id, label: clip('Load the ' + node.unread + ' unread children of ' + node.role + ' ' +
        JSON.stringify(clip(node.label, 80)) + (node.path.length ? ' in ' + node.path.slice(-2).join(' > ') : ''), 400) });
    scopes.push({ id: 'apps', label: 'List running and installed applications.' });
    scopes.push({ id: 'app-search', label: 'Search installed applications by name; put the name in query.' });
    return scopes.slice(0, 60);
  }

  /** A bounded selection by relevance, not by depth. Not selected means not shown, never absent. */
  select(options: SelectOptions): Selection {
    const pool = [...this.nodes, ...(options.extra ?? [])].filter(n => n.label || n.value);
    const retrieve = options.retrieve ?? RETRIEVE, limit = options.limit ?? MAX_ELEMENTS;
    const fields = new Map(pool.map(n => [n, {
      label: new Set(tokens(n.label)), value: new Set(tokens(n.value)), description: new Set(tokens(n.description)),
      role: new Set(tokens(n.role)), path: new Set(n.path.flatMap(tokens)),
    }]));
    const frequency = new Map<string, number>();
    for (const sets of fields.values())
      for (const token of new Set([...sets.label, ...sets.value, ...sets.description, ...sets.role]))
        frequency.set(token, (frequency.get(token) || 0) + 1);
    const idf = (token: string) => Math.log(1 + pool.length / (1 + (frequency.get(token) || 0)));
    const terms = new Map<string, number>();
    for (const token of options.requirementTerms.flatMap(tokens)) terms.set(token, Math.max(terms.get(token) || 0, 1));
    for (const token of tokens(options.query)) terms.set(token, 2);
    const phrase = options.query.trim().toLocaleLowerCase();
    const score = (node: IndexedNode) => {
      const sets = fields.get(node)!;
      let total = phrase.length >= 2 && node.label.toLocaleLowerCase().includes(phrase) ? 5 : 0;
      for (const [token, weight] of terms) {
        const field = sets.label.has(token) ? 3 : sets.value.has(token) ? 2 : sets.description.has(token) ? 1.5
          : sets.role.has(token) ? 1 : sets.path.has(token) ? 0.5
          : token.length >= 4 && [...sets.label].some(l => l.startsWith(token) || (l.length >= 4 && token.startsWith(l))) ? 1.5 : 0;
        total += field * weight * idf(token);
      }
      return total;
    };
    const chosen = new Map<IndexedNode, Set<string>>();
    const take = (node: IndexedNode, tag: string) => {
      if (chosen.size >= limit && !chosen.has(node)) return;
      chosen.set(node, (chosen.get(node) ?? new Set()).add(tag));
    };
    for (const node of pool.filter(n => n.kind === 'element' && n.states.includes('focused')).slice(0, 3)) take(node, 'focused');
    for (const node of pool.filter(n => n.inModal).slice(0, 25)) take(node, 'modal');
    if (options.previous && options.previous.viewKey === this.viewKey()) {
      const before = new Map<string, number>();
      for (const fact of options.previous.facts) before.set(fact, (before.get(fact) || 0) + 1);
      let changed = 0;
      for (const node of this.nodes.filter(n => n.kind === 'element' && (n.identity.label || n.value || n.unread))) {
        const fact = factOf(node);
        const count = before.get(fact) || 0;
        if (count) before.set(fact, count - 1);
        else if (changed++ < 15) take(node, 'changed');
      }
    }
    for (const identity of options.pinned.slice(0, 10))
      for (const node of this.find(identity, 'strong').slice(0, 2)) take(node, 'pinned');
    for (const node of pool.filter(n => n.kind === 'window').slice(0, 12)) take(node, 'window');
    for (const node of pool.filter(n => n.kind === 'application' && n.states.includes('running')).slice(0, 15)) take(node, 'application');
    const ranked = pool.map((node, order) => ({ node, order, score: score(node) }))
      .sort((a, b) => b.score - a.score || Number(b.node.operations.length > 0) - Number(a.node.operations.length > 0) ||
        Number(a.node.states.includes('offscreen')) - Number(b.node.states.includes('offscreen')) ||
        a.node.depth - b.node.depth || a.order - b.order);
    let retrieved = 0;
    for (const { node, score: value } of ranked) {
      if (retrieved >= retrieve || chosen.size >= limit) break;
      // With no matching terms, fall back to the shallowest controls of the current window.
      if (value === 0 && (node.kind !== 'element' || !node.operations.length)) continue;
      if (!chosen.has(node)) retrieved++;
      take(node, value > 0 ? (node.kind === 'menu' ? 'menu' : 'match') : 'nearby');
    }
    const elements = [...chosen.entries()].map(([node, tags]): PlanElement => ({
      id: node.id, role: node.role, label: clip(node.label, 400), value: clip(node.value, 600),
      states: node.states.slice(0, 20).map(s => clip(s, 60)), path: clip(node.path.slice(-6).join(' > '), 600),
      operations: node.operations,
      tags: [...tags, ...(node.kind === 'menu' && !tags.has('menu') ? ['menu'] : []), ...(node.lowInformation ? ['unlabeled'] : []),
        ...(node.unread ? ['unread:' + node.unread] : [])].slice(0, 8),
    }));
    return { elements, scopes: this.scopes([...chosen.keys()]) };
  }
}
