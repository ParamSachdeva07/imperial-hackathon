import type {
  AccessibilityNode,
  DesktopCandidate,
  DesktopContext,
  DesktopDecisionRequest,
  DesktopObservation,
} from '../../../../packages/contracts/src/index';
import { activeModal } from '../desktop/modal-scope';
import { nativeActionBudget } from './choice-budget';

function treeDepth(node: AccessibilityNode): number {
  return node.children.length ? 1 + Math.max(...node.children.map(treeDepth)) : 0;
}
function treeAtDepth(node: AccessibilityNode, depth: number): AccessibilityNode {
  if (!depth && node.children.length)
    return { ...node, children: [], childrenCount: node.children.length + (node.childrenCount || 0) };
  return { ...node, children: node.children.map(child => treeAtDepth(child, depth - 1)) };
}
function treeSize(node: AccessibilityNode): number {
  return 1 + node.children.reduce((count, child) => count + treeSize(child), 0);
}

const visible = (node: AccessibilityNode) => !node.states.includes('hidden');
function label(node: AccessibilityNode): string {
  return (
    node.name ||
    node.description ||
    (node.nativeId?.startsWith('_NS:') ? '' : node.nativeId) ||
    node.role
  ).slice(0, 150);
}
function preview(node: AccessibilityNode): string {
  const entries: { priority: number; text: string }[] = [];
  const visit = (n: AccessibilityNode) => {
    if (!visible(n)) return;
    const name = n.name || n.description || '';
    const region = ['webarea', 'banner', 'main', 'navigation', 'search', 'toolbar', 'menu'].includes(n.role);
    const input = ['textfield', 'combobox', 'textarea', 'searchfield'].includes(n.role);
    const unread = (n.childrenCount || 0) > 0;
    if (region || unread || (name && (input || n.actions.length || ['heading', 'link'].includes(n.role)))) {
      const priority = region
        ? 0
        : input && /^search$/i.test(name)
          ? 1
          : unread || input
            ? 2
            : n.role === 'heading'
              ? 3
              : 4;
      entries.push({
        priority,
        text:
          n.role +
          ': ' +
          label(n).slice(0, 90) +
          (unread ? ' (' + n.childrenCount + ' unread children)' : ''),
      });
    }
    for (const child of n.children) visit(child);
  };
  for (const child of node.children) visit(child);
  return [...new Set(entries.sort((a, b) => a.priority - b.priority).map((e) => e.text))]
    .slice(0, 10)
    .join('; ');
}
function meaningfulChildren(node: AccessibilityNode): AccessibilityNode[] {
  const expand = (child: AccessibilityNode): AccessibilityNode[] => {
    if (!visible(child)) return [];
    const children = child.children.filter(visible);
    const structuralGroup =
      child.role === 'group' &&
      !child.name &&
      !child.description &&
      !child.value &&
      !(child.childrenCount || 0) &&
      (!child.ref || (children.length > 0 && child.actions.every(a => ['Click', 'RightClick', 'SetFocus', 'ScrollTo'].includes(a))));
    const wrapper =
      structuralGroup || (!child.ref && !child.value && child.role === 'menu' && child.name === node.name);
    // Anonymous layout wrappers have no separate choice to make. Promote their
    // children together, while retaining named, actionable and unread regions.
    if (wrapper) return children.flatMap(expand);
    return [child];
  };
  return node.children.flatMap(expand);
}
function semanticLabel(node: AccessibilityNode): string {
  const own = node.name || node.description ||
    (node.nativeId?.startsWith('_NS:') ? '' : node.nativeId);
  if (own) return own.slice(0, 500);
  if (!['link', 'button', 'menuitem', 'option', 'checkbox', 'radiobutton', 'radio', 'switch', 'tab'].includes(node.role))
    return '';
  const labels: string[] = [];
  const visit = (child: AccessibilityNode) => {
    if (!visible(child) || labels.length >= 3) return;
    // An embedded player/editor/button has its own meaning. Its captions or
    // content must not be promoted to the enclosing control's action label.
    if (child.actions.some(action => ['Click', 'SetValue', 'Type', 'TypeText', 'Select', 'Toggle', 'Check'].includes(action))) return;
    const textRole = ['statictext', 'heading', 'text', 'label', 'image'].includes(child.role);
    const text = textRole ? child.name || child.description || child.value : '';
    if (text && !labels.includes(text)) labels.push(text);
    for (const descendant of child.children) visit(descendant);
  };
  for (const child of node.children) visit(child);
  return labels.join(' · ').slice(0, 500);
}
export class TreeBrowser {
  private root?: AccessibilityNode;
  readonly modal?: AccessibilityNode;
  private path: AccessibilityNode[] = [];
  private apps: boolean;
  private visits = new Map<string, number>();
  private browsePaths = new Map<string, AccessibilityNode[]>();
  constructor(private observation: DesktopObservation) {
    const snapshot = observation.snapshots[0];
    this.root =
      snapshot?.tree ||
      (snapshot
        ? {
            id: 'root',
            role: 'window',
            name: snapshot.windowTitle,
            value: '',
            states: [],
            actions: [],
            children: snapshot.elements.map((e, i) => ({ ...e, id: 'element_' + i, children: [] })),
          }
        : undefined);
    this.modal = activeModal(this.root);
    // Start at the blocking dialog, retaining all sibling choices. A focused
    // filename/editor must not hide the dialog's other controls.
    if (this.modal) this.root = this.modal;
    if (this.root) {
      this.path = [this.root];
      // Loaded descendants are direct choices, including the focused editor.
      // Narrowing the view to it would hide already-loaded siblings and force
      // another model call merely to get back to their shared container.
    }
    this.apps = !this.root;
  }
  metadata(): DesktopDecisionRequest['tree'] {
    const scope = this.observation.context.scopePath || [];
    const path = scope.length
      ? [
          {
            id: 'window',
            name: this.observation.snapshots[0]?.windowTitle || this.observation.context.app || 'Window',
          },
          ...scope.map((n) => ({ id: n.ref, name: n.name })),
          ...this.path.slice(1).map((n) => ({ id: n.id, name: label(n) })),
        ]
      : this.path.map((n) => ({ id: n.id, name: label(n) }));
    return {
      view: this.apps ? 'applications' : 'tree',
      path: this.apps ? [{ id: 'applications', name: 'Applications' }] : path,
      children: this.apps
        ? this.observation.applications.length
        : meaningfulChildren(this.path.at(-1)!).length,
      canGoUp: this.apps ? !!this.root : this.path.length > 1 || !!this.observation.context.rootRef,
    };
  }
  nativeNavigation(direction: string): DesktopContext | undefined {
    const context = this.observation.context;
    if (
      !context.rootRef ||
      (direction !== 'GO_ROOT' && (direction !== 'GO_PARENT' || this.apps || this.path.length > 1))
    )
      return;
    const scopePath = direction === 'GO_ROOT' ? [] : (context.scopePath || []).slice(0, -1);
    const next = { ...context };
    if (scopePath.length) {
      next.scopePath = scopePath;
      next.rootRef = scopePath.at(-1)!.ref;
    } else {
      delete next.scopePath;
      delete next.rootRef;
    }
    return next;
  }
  up() {
    if (!this.metadata().canGoUp || (!this.apps && this.path.length === 1))
      throw new Error('The tree root requires a fresh parent-scope read.');
    if (this.apps) this.apps = false;
    else this.path.pop();
  }
  goRoot() {
    if (!this.root) throw new Error('No current window tree.');
    this.apps = false;
    this.path = [this.root];
  }
  navigate(candidate: DesktopCandidate) {
    if (candidate.operation === 'BROWSE_APPS') {
      this.apps = true;
      return;
    }
    const route = this.browsePaths.get(candidate.nodeId || '');
    const child = route?.at(-1);
    if (!child || !child.children.length) throw new Error('Branch is not a child of the current node.');
    this.visits.set(child.id, (this.visits.get(child.id) || 0) + 1);
    this.path.push(...route!);
  }
  view(allCandidates: DesktopCandidate[]): {
    observation: DesktopObservation;
    candidates: DesktopCandidate[];
  } {
    if (this.apps)
      return {
        observation: { ...this.observation, snapshots: [] },
        candidates: allCandidates.filter((c) => ['OPEN_APP', 'SEARCH_APPS'].includes(c.operation)),
      };
    if (this.observation.context.driver === 'browser')
      return { observation: this.observation, candidates: allCandidates.filter(c => c.operation !== 'OPEN_APP') };
    const root = this.path.at(-1)!;
    if (!this.observation.snapshots[0].tree) return this.treeView(allCandidates, root);
    const maximumDepth = treeDepth(root);
    const budget = nativeActionBudget(this.metadata().canGoUp, this.observation.snapshots.every(s => s.complete));
    // Add complete layers in order; stop before the FIRST overflowing layer.
    // Rebuild choices because a newly retained boundary needs a descent option.
    let retainedDepth = -1;
    for (let depth = 0; depth <= maximumDepth; depth++) {
      const tree = depth === maximumDepth ? root : treeAtDepth(root, depth);
      const view = this.treeView(allCandidates, tree);
      if (view.candidates.length > budget) break;
      retainedDepth = depth;
    }
    if (retainedDepth < 0)
      throw new Error('The current scope has too many global actions to fit Jev’s 255-choice limit. No desktop action was sent.');
    const tree = retainedDepth === maximumDepth ? root : treeAtDepth(root, retainedDepth);
    const view = this.treeView(allCandidates, tree);
    if (retainedDepth < maximumDepth) view.observation.notices = [
      `Action-choice budget: retained ${retainedDepth + 1} complete layers (${treeSize(tree)} nodes); ${view.candidates.length} actions plus reserved navigation fit within 255. The entire next layer is excluded; select a boundary branch to continue.`,
      ...view.observation.notices,
    ];
    if (retainedDepth === 0 && root.children.length) view.observation.notices.unshift(
      'Observation limit: the immediate layer exceeds the action-choice budget. Its children are unknown; do not repeat this scope or claim completion.');
    return view;
  }
  private treeView(allCandidates: DesktopCandidate[], current: AccessibilityNode): {
    observation: DesktopObservation;
    candidates: DesktopCandidate[];
  } {
    const children = meaningfulChildren(current);
    const snapshot = this.observation.snapshots[0];
    const routes = new Map<string, AccessibilityNode[]>();
    const index = (node: AccessibilityNode, route: AccessibilityNode[]) => {
      routes.set(node.id, route);
      for (const child of node.children) index(child, [...route, child]);
    };
    index(this.path.at(-1)!, []);
    this.browsePaths.clear();
    const visibleNodes: AccessibilityNode[] = [];
    const paths = new Map<string, string>();
    const parents = new Map<string, string>();
    const collect = (node: AccessibilityNode, ancestry: string[], parentId = 'scope') => {
      if (!visible(node)) return;
      visibleNodes.push(node);
      paths.set(node.id, [...ancestry, label(node)].join(' > '));
      parents.set(node.id, parentId);
      for (const child of meaningfulChildren(node)) collect(child, [...ancestry, label(node)], node.id);
    };
    collect(current, []);
    const refs = new Set(visibleNodes.map((n) => n.ref).filter(Boolean));
    const landmarks = new Set(visibleNodes.filter(n =>
      ['banner', 'main', 'navigation', 'search', 'complementary', 'contentinfo', 'region', 'group', 'webarea', 'scrollarea'].includes(n.role) &&
      (n.children.length > 0 || (n.childrenCount || 0) > 0)).map(n => n.ref));
    const targets = new Map(visibleNodes.filter(n => n.ref).map(n => [n.ref!, n]));
    const candidates = allCandidates.filter(
      (c) =>
        ['READ_WINDOW', 'READ_SURFACE', 'READ_BROWSER', 'FOCUS_WINDOW', 'PRESS', 'WAIT', 'SEARCH_APPS'].includes(c.operation) ||
        (c.targetRef && refs.has(c.targetRef) &&
          !(landmarks.has(c.targetRef) && ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK'].includes(c.operation))),
    ).flatMap(candidate => {
      const node = candidate.targetRef ? targets.get(candidate.targetRef) : undefined;
      if (!node) return [candidate];
      const meaning = semanticLabel(node);
      // A role such as "link" describes a capability, not the target's purpose.
      // Keep such nodes available to inspect; do not offer an unidentified click.
      if (!meaning && ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK'].includes(candidate.operation)) return [];
      const childContext = preview(node);
      return [{ ...candidate, nodeId: node.id,
        name: !node.name && !node.description && meaning ? meaning : candidate.name,
        description: ('Observed path: ' + paths.get(node.id) + '. ' + candidate.description + (childContext ? '; Child context: ' + childContext : '')).slice(0, 2000),
      }];
    });
    const branches = new Map(children.map(node => [node.id, node]));
    // A projected boundary can be several levels down and can lack a native
    // action ref. Its cached original subtree is still available for traversal.
    for (const node of visibleNodes)
      if (node.id !== current.id && !node.children.length && routes.get(node.id)?.at(-1)?.children.length)
        branches.set(node.id, node);
    for (const node of branches.values()) {
      const route = routes.get(node.id), original = route?.at(-1);
      if (original?.children.length) {
        this.browsePaths.set(node.id, route!);
        candidates.push({
          id: 'branch_' + node.id,
          operation: 'BROWSE_TREE',
          app: snapshot.app,
          snapshotId: snapshot.id,
          nodeId: node.id,
          name: label(node),
          description:
            'Read this child branch without clicking or typing. Previously inspected ' +
            (this.visits.get(node.id) || 0) +
            ' times in this unchanged tree. ' + (node.children.length ? 'Contains: ' + preview(node) : 'Read the next complete layers from this boundary.'),
        });
      }
    }
    candidates.push({
      id: 'browse_apps',
      operation: 'BROWSE_APPS',
      app: snapshot.app,
      name: 'Applications',
      description:
        'Browse the application tree to switch to another running app or launch an installed app. Does not send desktop input.',
    });
    const nodeLines = visibleNodes.map(n => [
      '[' + n.id + '] parent=' + (parents.get(n.id) || 'scope'),
      n.role,
      label(n),
      n.value ? 'value=' + n.value.slice(0, 600) : '',
      n.states.length ? 'states=' + n.states.join(',') : '',
      n.childrenCount ? 'unread=' + n.childrenCount : '',
    ].filter(Boolean).join(' | '));
    // Keep read-only result labels as window context while navigating its hierarchy.
    const retainedElements = snapshot.elements.filter(e => refs.has(e.ref));
    const results = nodeLines
      .filter((line) => line.includes('statictext'))
      .slice(0, 20)
      .map((line) => 'Window result context: ' + line);
    const values = retainedElements
      .filter(
        (e) =>
          e.value &&
          ['textfield', 'textarea', 'combobox', 'searchfield', 'text', 'editabletext'].includes(e.role),
      )
      .slice(0, 8)
      .map(
        (e) =>
          'Window field context (read-only evidence): ' +
          (e.name || e.nativeId || e.role) +
          ' = ' +
          e.value.slice(0, 1000),
      );
    const controls = retainedElements
      .filter(e => !e.states.some(state => ['hidden', 'offscreen'].includes(state)) &&
        (e.states.some(state => ['focused', 'selected', 'checked', 'expanded'].includes(state)) ||
          (e.value && !['textfield', 'textarea', 'combobox', 'searchfield'].includes(e.role))))
      .slice(0, 12)
      .map(e => 'Window control context (read-only evidence): ' + e.role + ' ' + e.name +
        '; value=' + e.value.slice(0, 500) + '; states=' + e.states.join(','));
    const ancestors = this.path.slice(0, -1)
      .filter(n => n.role !== 'group' || !!n.name || !!n.description)
      .slice(-3)
      .map(n => 'Ancestor context (read-only; navigate before acting): ' + n.role + ' ' + label(n) +
        '; Child regions: ' + preview(n));
    return {
      observation: {
        ...this.observation,
        notices: this.modal ? [
          'Active modal: ' + label(this.modal) + '. Resolve this interruption before continuing the underlying task. Preserve unrelated work; modal controls are available in this branch.',
          ...this.observation.notices,
        ] : this.observation.notices,
        snapshots: [{ ...snapshot, tree: snapshot.tree ? current : undefined, elements: retainedElements, text: nodeLines, contextText: [...ancestors, ...results, ...values, ...controls] }],
      },
      candidates,
    };
  }
}
