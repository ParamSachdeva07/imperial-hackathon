import { z } from 'zod';

export const TaskInputSchema = z
  .object({
    mode: z.enum(['desktop', 'textedit']).default('desktop'),
    app: z.string().trim().max(200).default(''),
    allowPhysical: z.boolean().default(false),
    goal: z.string().trim().min(1).max(1000),
    text: z.string().max(5000).default(''),
    provider: z.enum(['jev', 'local']),
    maxSteps: z.number().int().min(1).max(500).default(160),
    supervisorEnabled: z.boolean().default(false),
    supervisorEvery: z.number().int().min(1).max(50).default(12),
    inputs: z.array(z.object({ id: z.string().min(1).max(50), text: z.string().min(1).max(5000) }).strict()).max(8).default([]),
  })
  .strict();
export type TaskInput = z.infer<typeof TaskInputSchema>;

const BoundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export type Bounds = z.infer<typeof BoundsSchema>;
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
  browser?: BrowserPageState;
};
export type BrowserPageState = {
  contentPending?: boolean;
  url: string;
  title: string;
  documentId: string;
  tabId: string;
  readyState: string;
  media: { kind: string; source: string; paused: boolean; ended: boolean; time: number; advancing: boolean }[];
};
export type AccessibilityNode = Omit<Element, 'ref'> & {
  id: string;
  ref?: string;
  children: AccessibilityNode[];
};
export type PreparedDocument = { app: 'TextEdit'; windowId: string; windowTitle: string; createdAt: number };
const CandidateSchema = z
  .object({
    id: z.string().min(1).max(100),
    operation: z.enum(['SET_VALUE', 'FOCUS', 'CLICK']),
    targetRef: z.string().regex(/^@[A-Za-z0-9]+:e\d+$/),
    role: z.string(),
    name: z.string(),
    description: z.string(),
    inputId: z.literal('document_text').optional(),
    bounds: BoundsSchema.optional(),
  })
  .strict();
export type Candidate = z.infer<typeof CandidateSchema>;
export const DecisionRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    step: z.number().int().min(1).max(12),
    snapshotId: z.string().min(1),
    goal: z.string().min(1).max(1000),
    app: z.literal('TextEdit'),
    windowId: z.string().min(1),
    input: z.object({ id: z.literal('document_text'), text: z.string().min(1).max(5000) }),
    candidates: z.array(CandidateSchema).max(100),
    history: z.array(z.string().max(400)).max(12),
  })
  .strict();
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
export const DecisionSchema = z
  .object({
    taskId: z.string().uuid(),
    snapshotId: z.string(),
    candidateId: z.string(),
    confidence: z.number().min(0).max(1),
    provider: z.enum(['jev', 'local']),
    model: z.string(),
    goalStatus: z.enum(['continue', 'completed', 'blocked']).optional(),
    goalConfidence: z.number().min(0).max(1).optional(),
    goalCompletionProbability: z.number().min(0).max(1).optional(),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

export type TaskStatus =
  | 'idle'
  | 'preparing'
  | 'observing'
  | 'deciding'
  | 'executing'
  | 'verifying'
  | 'paused'
  | 'stopping'
  | 'cancelled'
  | 'blocked'
  | 'completed'
  | 'failed';
export type TaskEvent = {
  id: number;
  at: number;
  taskId: string | null;
  type: 'state' | 'observation' | 'decision' | 'target' | 'step' | 'result' | 'error';
  message: string;
  details?: Record<string, unknown>;
};
export type ControllerState = {
  taskId: string | null;
  status: TaskStatus;
  busy: boolean;
  input: TaskInput | null;
  document: PreparedDocument | null;
  snapshot: Snapshot | null;
  decision: Decision | null;
  step: number;
  verifiedText: string | null;
  events: TaskEvent[];
  observation?: DesktopObservation | null;
  completion?: { kind: 'observed-text' | 'model-assessed'; summary: string; evidence: string[] } | null;
};
export type Health = {
  native: { available: boolean; version?: string; accessibility: string; message?: string };
  backend: { available: boolean; keyConfigured: boolean; model?: string; supervisorConfigured?: boolean; supervisorProvider?: string; supervisorModel?: string; message?: string };
};
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
export interface DesktopApi {
  applications(): Promise<ApiResult<Application[]>>;
  health(): Promise<ApiResult<Health>>;
  state(): Promise<ApiResult<ControllerState>>;
  prepare(): Promise<ApiResult<ControllerState>>;
  start(input: TaskInput, singleStep: boolean): Promise<ApiResult<ControllerState>>;
  replace(input: TaskInput, singleStep: boolean): Promise<ApiResult<ControllerState>>;
  resume(singleStep: boolean): Promise<ApiResult<ControllerState>>;
  cancel(): Promise<ApiResult<ControllerState>>;
  inspect(): Promise<ApiResult<ControllerState>>;
  openAccessibilitySettings(): Promise<ApiResult<void>>;
  setOverlayExpanded(expanded: boolean): Promise<ApiResult<void>>;
  onState(listener: (state: ControllerState) => void): () => void;
}

export type Application = { name: string; id: string; running: boolean; pid?: number };
export type DesktopWindow = { id: string; title: string; app: string; focused: boolean };
export type DesktopContext = {
  driver?: 'native' | 'browser';
  app?: string;
  windowId?: string;
  surface?: string;
  rootRef?: string;
  appSearch?: string;
  scopePath?: { ref: string; name: string }[];
};
export type DesktopObservation = {
  id: string;
  capturedAt: number;
  context: DesktopContext;
  applications: Application[];
  windows: DesktopWindow[];
  snapshots: Snapshot[];
  notices: string[];
};
const DesktopOperationSchema = z.enum([
  'BROWSE_TREE',
  'BROWSE_APPS',
  'OPEN_APP',
  'SEARCH_APPS',
  'FOCUS_WINDOW',
  'READ_WINDOW',
  'READ_SURFACE',
  'INSPECT_REGION',
  'READ_BROWSER',
  'NAVIGATE',
  'BACK',
  'FORWARD',
  'WAIT',
  'CLICK',
  'DOUBLE_CLICK',
  'RIGHT_CLICK',
  'SET_VALUE',
  'TYPE',
  'FOCUS_AND_PASTE',
  'FOCUS',
  'SELECT',
  'CHECK',
  'UNCHECK',
  'EXPAND',
  'COLLAPSE',
  'SCROLL',
  'SCROLL_TO',
  'PRESS',
]);
const DesktopCandidateSchema = z
  .object({
    id: z.string().min(1).max(100),
    operation: DesktopOperationSchema,
    description: z.string().max(2000),
    name: z.string().max(1000),
    app: z.string().min(1).max(200),
    windowId: z.string().optional(),
    snapshotId: z.string().optional(),
    targetRef: z
      .string()
      .regex(/^@[A-Za-z0-9]+:e\d+$/)
      .optional(),
    role: z.string().optional(),
    surface: z.string().optional(),
    inputId: z.string().optional(),
    key: z.string().optional(),
    inputFromGoal: z.boolean().optional(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    bounds: BoundsSchema.optional(),
    nodeId: z.string().optional(),
  })
  .strict();
export type DesktopCandidate = z.infer<typeof DesktopCandidateSchema>;
export const OutcomeTargetSchema = z.object({ app: z.string().max(200), windowTitle: z.string().max(1000),
  role: z.string().max(200), name: z.string().max(1000),
  windowId: z.string().max(200).optional(), nativeId: z.string().max(2000).optional(),
  nativeIdKind: z.string().max(100).optional(), path: z.string().max(4000).optional(),
}).strict();
export type OutcomeTarget = z.infer<typeof OutcomeTargetSchema>;
export const OutcomeCheckSchema = z.object({
  kind: z.enum(['target_present', 'text_equals', 'state_present', 'state_absent', 'value_advances']),
  target: OutcomeTargetSchema,
  value: z.string().max(5000),
}).strict();
export type OutcomeCheck = z.infer<typeof OutcomeCheckSchema>;
export const SupervisorGuidanceSchema = z.object({
  taskId: z.string(), snapshotId: z.string(),
  status: z.enum(['continue', 'completed', 'blocked']),
  subgoal: z.string().min(1).max(1000),
  plan: z.array(z.string().max(1000)).max(12),
  memory: z.array(z.string().max(1000)).max(16),
  inputs: z.array(z.object({ id: z.string().min(1).max(50), text: z.string().min(1).max(5000) }).strict()).max(8),
  expectedOutcome: z.object({
    kind: z.enum(['observed_state', 'text_equals', 'media_playing']),
    description: z.string().max(1000),
    target: OutcomeTargetSchema,
    value: z.string().max(5000),
    checks: z.array(OutcomeCheckSchema).max(12),
  }).strict(),
  evidence: z.array(z.string().max(2000)).max(12),
  rationale: z.string().max(2000),
}).strict();
export type SupervisorGuidance = z.infer<typeof SupervisorGuidanceSchema>;
const ActionResultSchema = z.object({
  operation: DesktopOperationSchema, target: z.string(), key: z.string().optional(),
  text: z.string().optional(), delivery: z.string(), verification: z.string(),
  before: z.array(z.string()), after: z.array(z.string()),
  scopeChanged: z.boolean(), added: z.array(z.string()), removed: z.array(z.string()),
}).strict();
export type ActionResult = z.infer<typeof ActionResultSchema>;
export const DesktopDecisionRequestSchema = z
  .object({
    mode: z.literal('desktop'),
    taskId: z.string().uuid(),
    step: z.number().int().min(1).max(500),
    supervisor: SupervisorGuidanceSchema.nullable().optional(),
    actionResult: ActionResultSchema.optional(),
    observedTargets: z.array(OutcomeTargetSchema.extend({ value: z.string(), states: z.array(z.string()) })).max(128).optional(),
    completionNeedsEvidence: z.boolean().optional(),
    snapshotId: z.string().min(1),
    goal: z.string().min(1).max(1000),
    context: z
      .object({
        driver: z.enum(['native', 'browser']).optional(),
        app: z.string().optional(),
        windowId: z.string().optional(),
        surface: z.string().optional(),
        rootRef: z.string().optional(),
        appSearch: z.string().optional(),
        scopePath: z
          .array(z.object({ ref: z.string(), name: z.string() }).strict())
          .max(50)
          .optional(),
      })
      .strict(),
    overallGoal: z.string().min(1).max(1000),
    phase: z.object({ index: z.number().int().min(0), count: z.number().int().min(1) }).strict(),
    tree: z
      .object({
        view: z.enum(['tree', 'applications']),
        path: z.array(z.object({ id: z.string(), name: z.string() })),
        children: z.number().int().min(0),
        canGoUp: z.boolean(),
      })
      .strict(),
    inputs: z.array(z.object({ id: z.string(), text: z.string().min(1).max(5000) }).strict()).max(8),
    observations: z
      .array(
        z
          .object({
            id: z.string(),
            app: z.string(),
            windowId: z.string(),
            title: z.string(),
            surface: z.string(),
            complete: z.boolean(),
            text: z.array(z.string().max(2000)).max(2200),
          })
          .strict(),
      )
      .max(3),
    candidates: z.array(DesktopCandidateSchema).max(2500),
    history: z.array(z.string().max(1000)).max(40),
    notices: z.array(z.string().max(1000)).max(20),
    page: z
      .object({
        index: z.number().int().min(0),
        count: z.number().int().min(1),
        totalChoices: z.number().int().min(0),
        seen: z.array(z.number().int().min(0)),
      })
      .strict(),
  })
  .strict();
export type DesktopDecisionRequest = z.infer<typeof DesktopDecisionRequestSchema>;

export const SupervisorRequestSchema = z.object({
  taskId: z.string().uuid(), snapshotId: z.string().min(1),
  step: z.number().int().min(1).max(500), goal: z.string().min(1).max(1000),
  reason: z.enum(['initial', 'interval', 'no_progress', 'uncertain_action', 'completion', 'blocked', 'text_needed', 'interruption', 'action_result']),
  observation: DesktopDecisionRequestSchema,
  previous: SupervisorGuidanceSchema.nullable(),
  issue: z.string().max(4000).default(''),
}).strict();
export type SupervisorRequest = z.infer<typeof SupervisorRequestSchema>;

export const TextResolutionRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    snapshotId: z.string().min(1),
    candidateId: z.string().min(1),
    goal: z.string().min(1).max(1000),
    purpose: z.enum(['field_text', 'app_name']),
    target: z
      .object({
        app: z.string(),
        role: z.string(),
        name: z.string(),
        description: z.string().max(2000),
        value: z.string().max(2000),
      })
      .strict(),
    history: z.array(z.string().max(1000)).max(10),
  })
  .strict();
export type TextResolutionRequest = z.infer<typeof TextResolutionRequestSchema>;
export const TextResolutionSchema = z
  .object({
    taskId: z.string(),
    snapshotId: z.string(),
    candidateId: z.string(),
    status: z.enum(['resolved', 'unavailable']),
    text: z.string().max(1000),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    confidence: z.number().min(0).max(1),
    supportConfidence: z.number().min(0).max(1),
    reason: z.enum(['no_span', 'invalid_boundaries', 'unsupported']).nullable().optional(),
    proposedText: z.string().max(1000).nullable().optional(),
    model: z.string(),
  })
  .strict();
export type TextResolution = z.infer<typeof TextResolutionSchema>;
