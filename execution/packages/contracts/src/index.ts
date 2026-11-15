import { z } from 'zod';

// ---- What a caller sends and what the overlay shows ----
export const TaskInputSchema = z.object({
  goal: z.string().trim().min(1).max(1000),
  /** What the caller says came before: its own notes, and how its earlier requests ended and where they left the computer. */
  context: z.string().max(6000).default(''),
  app: z.string().trim().max(200).default(''),
  allowPhysical: z.boolean().default(false),
}).strict();
export type TaskInput = z.infer<typeof TaskInputSchema>;
/** What a caller sends: fields with defaults may be left out. */
export type TaskRequest = z.input<typeof TaskInputSchema>;

export type TaskStatus = 'idle' | 'preparing' | 'observing' | 'deciding' | 'executing' | 'verifying' | 'stopping'
  | 'cancelled' | 'blocked' | 'completed' | 'completed_unverified' | 'failed';
export type TaskEvent = {
  id: number;
  at: number;
  taskId: string | null;
  type: 'state' | 'observation' | 'decision' | 'target' | 'step' | 'result' | 'error';
  message: string;
  details?: Record<string, unknown>;
};
export type PlanItem = { text: string; status: 'todo' | 'done' | 'skipped' };
export type Location = { app: string; window: string; address: string };
export type ControllerState = {
  taskId: string | null;
  status: TaskStatus;
  busy: boolean;
  input: TaskInput | null;
  /** Navigator decisions taken so far. */
  step: number;
  events: TaskEvent[];
  plan: PlanItem[];
  /** How the task ended, and where it left the desktop. A caller can pass this to its next request. */
  completion: { summary: string; facts: string[]; location: Location } | null;
};
export type Health = {
  native: { available: boolean; version?: string; accessibility: string; message?: string };
  backend: { available: boolean; navigatorConfigured?: boolean; navigatorProvider?: string; navigatorModel?: string;
    orchestratorConfigured?: boolean; orchestratorProvider?: string; orchestratorModel?: string; message?: string };
  pageBridge?: { connected: boolean; needsReload?: boolean };
};
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
export interface DesktopApi {
  health(): Promise<ApiResult<Health>>;
  state(): Promise<ApiResult<ControllerState>>;
  start(input: TaskRequest): Promise<ApiResult<ControllerState>>;
  replace(input: TaskRequest): Promise<ApiResult<ControllerState>>;
  cancel(): Promise<ApiResult<ControllerState>>;
  openAccessibilitySettings(): Promise<ApiResult<void>>;
  setOverlayExpanded(expanded: boolean): Promise<ApiResult<void>>;
  onState(listener: (state: ControllerState) => void): () => void;
}

// ---- What the desktop and page adapters report ----
export type Bounds = { x: number; y: number; width: number; height: number };
export type Element = {
  ref: string;
  role: string;
  name: string;
  value: string;
  nativeId?: string;
  nativeIdKind?: string;
  actions: string[];
  states: string[];
  bounds?: Bounds;
  description?: string;
  path?: string;
  childrenCount?: number;
};
export type AccessibilityNode = Omit<Element, 'ref'> & { id: string; ref?: string; children: AccessibilityNode[] };
export type Snapshot = {
  id: string;
  app: string;
  windowId: string;
  windowTitle: string;
  complete: boolean;
  capturedAt: number;
  elements: Element[];
  surface?: string;
  text?: string[];
  contextText?: string[];
  tree?: AccessibilityNode;
};
export type Application = { name: string; id: string; running: boolean; pid?: number };
export type DesktopWindow = { id: string; title: string; app: string; focused: boolean };
export type DesktopContext = {
  driver?: 'native' | 'browser';
  app?: string;
  windowId?: string;
  surface?: string;
  rootRef?: string;
  appSearch?: string;
  /** `anchor` records where a region sits in the window, so a read scoped to it keeps the same identities. */
  scopePath?: { ref: string; name: string; anchor?: { trail: string[]; index: number } }[];
};
export type DesktopObservation = {
  id: string;
  capturedAt: number;
  context: DesktopContext;
  applications: Application[];
  windows: DesktopWindow[];
  snapshots: Snapshot[];
  notices: string[];
  /** The browser extension is connected, so this browser's page can be read directly. */
  pageBridge?: boolean;
};
export type DesktopOperation = 'OPEN_APP' | 'SEARCH_APPS' | 'FOCUS_WINDOW' | 'CLICK' | 'DOUBLE_CLICK' | 'RIGHT_CLICK'
  | 'SET_VALUE' | 'TYPE' | 'FOCUS_AND_PASTE' | 'FOCUS' | 'SELECT' | 'CHECK' | 'UNCHECK' | 'EXPAND' | 'COLLAPSE'
  | 'SCROLL' | 'SCROLL_TO' | 'PRESS';
/** One action on one observed target, as handed to an adapter. */
export type DesktopCandidate = {
  id: string;
  operation: DesktopOperation;
  description: string;
  name: string;
  app: string;
  windowId?: string;
  snapshotId?: string;
  targetRef?: string;
  role?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  bounds?: Bounds;
};

// ---- Navigator: one step at a time inside a session ----
export const PLAN_OPERATIONS = ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE',
  'FOCUS', 'SELECT', 'CHECK', 'UNCHECK', 'EXPAND', 'COLLAPSE', 'SCROLL', 'SCROLL_TO', 'PRESS', 'OPEN_APP',
  'FOCUS_WINDOW', 'OPEN_URL', 'SEARCH_WEB'] as const;
export type PlanOperation = (typeof PLAN_OPERATIONS)[number];
export type PlanElement = {
  id: string;
  role: string;
  label: string;
  value: string;
  states: string[];
  path: string;
  operations: PlanOperation[];
  tags: string[];
};
export type Scope = { id: string; label: string };
const ModelUsageSchema = z.object({
  provider: z.string(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
}).strict();

/** What Luna assigns to one navigator session. */
export type Mission = { objective: string; doneWhen: string; context: string };
/** What one navigator session hands back. The same object is stored, traced and shown to Luna. */
export type SessionResult = {
  status: 'done' | 'progress' | 'needs_decision' | 'blocked' | 'unverified' | 'error';
  summary: string;
  /** Text of the elements the navigator cited. */
  facts: string[];
  location: Location;
  /** Actions that were sent but whose outcome is not known. */
  unresolved: string[];
  steps: number;
};
export type EffectView = {
  id: string; operation: string; target: string; text?: string; key?: string; direction?: string;
  delivery: string; outcome: string; expect: string; readback?: string;
  added: string[]; removed: string[]; scopeChanged: boolean; note: string;
};
export type PlanRequest = {
  taskId: string;
  observationId: string;
  /** The user's words. They authorise the work; the mission says what to do now. */
  goal: string;
  mission: Mission;
  effects: EffectView[];
  observation: {
    app: string; windowId: string; windowTitle: string; surface: string; complete: boolean;
    scope: string[]; outline: string[];
    windows: { id: string; title: string; focused: boolean }[];
    notices: string[];
  };
  elements: PlanElement[];
  scopes: Scope[];
  allowedKeys: string[];
  /** Operations that need no target and are available now. */
  tools: PlanOperation[];
  query: string;
  /** What the controller refused or noticed about the previous step. */
  issues: string[];
};
export const PlanStepSchema = z.object({
  taskId: z.string(), observationId: z.string(), model: z.string(),
  reconciliations: z.array(z.object({ effectId: z.string(), outcome: z.enum(['confirmed', 'refuted']),
    evidence: z.array(z.string()).max(6) }).strict()).max(8),
  kind: z.enum(['act', 'find', 'read', 'wait', 'yield']),
  operation: z.union([z.enum(PLAN_OPERATIONS), z.literal('')]),
  target: z.string().max(40),
  text: z.string().max(5000),
  key: z.string().max(40),
  direction: z.enum(['', 'up', 'down', 'left', 'right']),
  expect: z.string().max(500),
  query: z.string().max(300),
  scope: z.string().max(60),
  waitMs: z.number().int().min(0).max(5000),
  /** Present on yield: what the session achieved, with the elements that show it. The broker omits it otherwise. */
  report: z.object({
    status: z.enum(['done', 'progress', 'needs_decision', 'blocked', 'unverified']),
    summary: z.string().max(1000), evidence: z.array(z.string()).max(12),
  }).strict().nullish(),
  usage: ModelUsageSchema.optional(),
}).strict();
export type PlanStep = z.infer<typeof PlanStepSchema>;

// ---- Luna: one decision per call ----
export type OrchestratorRequest = {
  taskId: string;
  goal: string;
  callerContext: string;
  plan: PlanItem[];
  /** Every finished session of this task, oldest first. */
  history: { assignment: Mission; result: SessionResult }[];
  screen: {
    app: string; title: string; address: string; driver: string; complete: boolean;
    notices: string[]; elements: PlanElement[]; scopes: Scope[]; tools: PlanOperation[];
  };
};
export const OrchestratorResultSchema = z.object({
  taskId: z.string(), model: z.string(),
  next: z.enum(['continue', 'finish', 'blocked']),
  objective: z.string().max(1000), doneWhen: z.string().max(1000), context: z.string().max(3000),
  plan: z.array(z.object({ text: z.string().max(500), status: z.enum(['todo', 'done', 'skipped']) }).strict()).max(12),
  message: z.string().max(1500),
  usage: ModelUsageSchema.optional(),
}).strict();
export type OrchestratorResult = z.infer<typeof OrchestratorResultSchema>;
