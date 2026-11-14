import { createHash } from 'node:crypto';
import type {
  DesktopObservation,
  DesktopCandidate,
  TaskInput,
  DesktopDecisionRequest,
} from '../../../../packages/contracts/src/index';
import { exactInputs } from './task-instructions';
import { observedElements } from '../desktop/observation-facts';
import { MAX_JEV_CHOICES } from './choice-budget';
import { OutcomeTargetSchema } from '../../../../packages/contracts/src/index';

const PAGE_SIZE = 240;
export function fingerprint(observation: DesktopObservation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        context: {
          app: observation.context.app,
          windowId: observation.context.windowId,
          surface: observation.context.surface,
          appSearch: observation.context.appSearch,
          scopePath: observation.context.scopePath?.map((s) => s.name),
        },
        windows: observation.windows,
        snapshots: observation.snapshots.map((s) => ({
          app: s.app,
          window: s.windowId,
          complete: s.complete,
          text: s.text,
          elements: s.elements.map(({ ref: _ref, ...e }) => e),
        })),
      }),
    )
    .digest('hex');
}
export function decisionPage(
  observation: DesktopObservation,
  candidates: DesktopCandidate[],
  input: TaskInput,
  taskId: string,
  step: number,
  index: number,
  seen: Set<number>,
  history: string[],
): DesktopDecisionRequest {
  const text = observation.snapshots.flatMap((snapshot) =>
    (snapshot.text || []).map((line) => ({ snapshot, line })),
  );
  // TreeBrowser has already retained complete layers that fit the action budget.
  // Native layers travel together; legacy/browser inventories retain paging.
  const boundedTree = observation.context.driver !== 'browser' && observation.snapshots.length > 0 &&
    observation.snapshots.every(s => s.tree);
  if (boundedTree && candidates.length > MAX_JEV_CHOICES - 2)
    throw new Error('Native tree choices exceeded the complete-layer budget before inference.');
  const pinned = candidates.filter(c => c.operation === 'SEARCH_APPS');
  const pageable = candidates.filter(c => c.operation !== 'SEARCH_APPS');
  const pageSize = boundedTree ? Math.max(1, pageable.length) : PAGE_SIZE - pinned.length;
  const count = boundedTree ? 1 : Math.max(1, Math.ceil(pageable.length / pageSize), Math.ceil(text.length / PAGE_SIZE));
  const page = Math.min(index, count - 1);
  const pageCandidates = [...pinned, ...pageable.slice(page * pageSize, (page + 1) * pageSize)];
  const lines = boundedTree ? text : text.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return {
    mode: 'desktop',
    taskId,
    step,
    snapshotId: observation.id,
    goal: input.goal,
    context: observation.context,
    overallGoal: input.goal,
    phase: { index: 0, count: 1 },
    tree: {
      view: observation.snapshots.length ? 'tree' : 'applications',
      path: [{ id: 'root', name: observation.context.app || 'Applications' }],
      children: candidates.length,
      canGoUp: false,
    },
    inputs: exactInputs(input),
    observedTargets: [...new Map(observation.snapshots.flatMap(s => [
      { app: s.app, windowId: s.windowId, windowTitle: s.windowTitle, role: 'window', name: s.windowTitle, value: '', states: [] },
      ...observedElements(s).filter(e => !e.states.some(v => ['hidden', 'offscreen'].includes(v))).map(e =>
        ({ app: s.app, windowId: s.windowId, windowTitle: s.windowTitle, role: e.role, name: e.name,
          nativeId: e.nativeId, nativeIdKind: e.nativeIdKind, path: e.path,
          value: e.value.slice(0, 2000), states: e.states })),
    // Never truncate an identifier into a different identity. Controls whose
    // identity cannot fit the contract remain visible in the observation text.
    ]).filter(({ value: _value, states: _states, ...identity }) => OutcomeTargetSchema.safeParse(identity).success)
      .map(target => [JSON.stringify(target), target])).values()].slice(0, 128),
    candidates: pageCandidates,
    observations: observation.snapshots.map((s) => ({
      id: s.id,
      app: s.app,
      windowId: s.windowId,
      title: s.windowTitle,
      surface: s.surface || 'window',
      complete: s.complete,
      text: [
        ...(s.contextText || []).slice(0, 50).map(line => line.slice(0, 2000)),
        ...lines.filter((l) => l.snapshot.id === s.id).map((l) => l.line.slice(0, 2000)),
      ],
    })),
    // Keep actual outcomes when many read-only branch moves would push them out.
    history: history.filter((entry, i) => i >= history.length - 16 ||
      (!/^(?:Read tree branch:|Read more siblings|Reading (?:the window top level|the parent scope))/.test(entry)))
      .slice(-40),
    notices: observation.notices.slice(0, 20),
    page: { index: page, count, totalChoices: candidates.length, seen: [...seen].sort((a, b) => a - b) },
  };
}
