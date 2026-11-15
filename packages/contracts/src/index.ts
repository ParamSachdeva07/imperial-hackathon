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
    // v2 is the planner-owned controller described in docs/controller-redesign.md.
    controller: z.enum(['v1', 'v2']).default('v1'),
    grounding: z.enum(['planner', 'jev']).default('planner'),
    orchestration: z.boolean().default(false),
    confirmIrreversible: z.boolean().default(true),
  })
  .strict();
export type TaskInput = z.infer<typeof TaskInputSchema>;
/** What a caller sends: fields with defaults may be left out. */
export type TaskRequest = z.input<typeof TaskInputSchema>;

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
  | 'completed_unverified'
  | 'needs_user'
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
  completion?: { kind: 'observed-text' | 'model-assessed' | 'requirements'; summary: string; evidence: string[] } | null;
  question?: { kind: 'question' | 'confirm'; text: string } | null;
  requirements?: { id: string; text: string; irreversible: boolean; status: string }[];
};
export type Health = {
  native: { available: boolean; version?: string; accessibility: string; message?: string };
  backend: { available: boolean; keyConfigured: boolean; model?: string; supervisorConfigured?: boolean; supervisorProvider?: string; supervisorModel?: string;
    orchestratorConfigured?: boolean; orchestratorProvider?: string; orchestratorModel?: string; message?: string };
  pageBridge?: { connected: boolean; needsReload?: boolean };
};
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
export interface DesktopApi {
  applications(): Promise<ApiResult<Application[]>>;
  health(): Promise<ApiResult<Health>>;
  state(): Promise<ApiResult<ControllerState>>;
  prepare(): Promise<ApiResult<ControllerState>>;
  start(input: TaskRequest, singleStep: boolean): Promise<ApiResult<ControllerState>>;
  replace(input: TaskRequest, singleStep: boolean): Promise<ApiResult<ControllerState>>;
  resume(singleStep: boolean): Promise<ApiResult<ControllerState>>;
  cancel(): Promise<ApiResult<ControllerState>>;
  answer(text: string): Promise<ApiResult<ControllerState>>;
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

// ---- v2 planner contracts (docs/controller-redesign.md) ----
export const PLAN_OPERATIONS = ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE',
  'FOCUS', 'SELECT', 'CHECK', 'UNCHECK', 'EXPAND', 'COLLAPSE', 'SCROLL', 'SCROLL_TO', 'PRESS', 'OPEN_APP',
  'FOCUS_WINDOW', 'OPEN_URL'] as const;
export type PlanOperation = (typeof PLAN_OPERATIONS)[number];
export const CHECK_KINDS = ['target_present', 'text_equals', 'state_present', 'state_absent', 'value_advances'] as const;

export const PlanElementSchema = z.object({
  id: z.string().min(1).max(40),
  role: z.string().max(100),
  label: z.string().max(400),
  value: z.string().max(600),
  states: z.array(z.string().max(60)).max(20),
  path: z.string().max(600),
  operations: z.array(z.enum(PLAN_OPERATIONS)).max(20),
  tags: z.array(z.string().max(40)).max(8),
}).strict();
export type PlanElement = z.infer<typeof PlanElementSchema>;

export const ModelUsageSchema = z.object({
  provider: z.string(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
}).strict();
export const NavigationMilestoneSchema = z.object({
  id: z.string().min(1).max(40), text: z.string().min(1).max(500),
  doneWhen: z.string().min(1).max(500), condition: z.string().max(500),
  dependsOn: z.array(z.string().min(1).max(40)).max(12),
  kind: z.enum(['outcome', 'text_entry']), irreversible: z.boolean(),
}).strict();
export type NavigationMilestone = z.infer<typeof NavigationMilestoneSchema>;
export const BranchDecisionSchema = z.object({
  milestoneId: z.string().min(1).max(40), disposition: z.enum(['run', 'skip']),
  sourceMilestoneIds: z.array(z.string().min(1).max(40)).min(1).max(12), reason: z.string().min(1).max(500),
}).strict();
export type BranchDecision = z.infer<typeof BranchDecisionSchema>;
export const MilestoneReviewSchema = z.object({
  milestoneId: z.string().min(1).max(40), evidence: z.array(z.string().min(1).max(40)).min(1).max(6),
  status: z.enum(['evidenced', 'open', 'unverifiable']).optional(),
  reason: z.string().max(1000).optional(),
}).strict();
export const NavigationCompletionProposalSchema = z.object({
  milestoneId: z.string().min(1).max(40), observationId: z.string(),
  summary: z.string().max(1000), evidence: z.array(z.string().max(700)).max(6),
}).strict();
export type NavigationCompletionProposal = z.infer<typeof NavigationCompletionProposalSchema>;
export const NavigationInputSchema = z.object({ name: z.string().max(80), value: z.string().max(5000) }).strict();
export const SemanticRecordSchema = z.object({
  taskId: z.string(), kind: z.enum(['instruction', 'assignment', 'result', 'decision', 'correction', 'checkpoint']),
  summary: z.string().max(6000),
  inputs: z.array(NavigationInputSchema).max(32).default([]),
  facts: z.array(z.string().max(1000)).max(80).default([]),
}).strict();
export type SemanticRecord = z.infer<typeof SemanticRecordSchema>;
export const NavigationReportSchema = z.object({
  status: z.enum(['progress', 'objective_met', 'needs_decision', 'blocked', 'unverified']),
  summary: z.string().max(1000), evidence: z.array(z.string().max(40)).max(12),
  remaining: z.array(z.string().max(500)).max(8),
}).strict();
export const NavigationMissionSchema = z.object({
  objective: z.string().min(1).max(1000), context: z.string().max(2500),
  doneWhen: z.string().max(1000).optional(),
  inputs: z.array(NavigationInputSchema).max(8).optional(),
  allowRepetition: z.boolean().optional(),
  milestone: NavigationMilestoneSchema.optional(),
}).strict();
export type NavigationMission = z.infer<typeof NavigationMissionSchema>;

export const PlanRequestSchema = z.object({
  taskId: z.string().uuid(),
  observationId: z.string().min(1),
  step: z.number().int().min(1).max(500),
  goal: z.string().min(1).max(1000),
  literals: z.array(z.string().max(5000)).max(8),
  answers: z.array(z.object({ question: z.string().max(1000), answer: z.string().max(1000) }).strict()).max(8),
  requirements: z.array(z.object({
    id: z.string().min(1).max(40), text: z.string().min(1).max(500), irreversible: z.boolean(),
    kind: z.enum(['outcome', 'text_entry']),
    status: z.enum(['open', 'evidenced', 'refuted', 'unverifiable']), evidence: z.array(z.string().max(700)).max(6),
  }).strict()).max(12),
  effects: z.array(z.object({
    id: z.string(), step: z.number().int(), requirementId: z.string(), operation: z.string(),
    target: z.string().max(400), text: z.string().max(600).optional(), key: z.string().optional(),
    direction: z.string().optional(), risk: z.string(), delivery: z.string(), outcome: z.string(),
    expect: z.string().max(500), readback: z.string().max(600).optional(),
    added: z.array(z.string().max(700)).max(12), removed: z.array(z.string().max(700)).max(12),
    scopeChanged: z.boolean(), note: z.string().max(500),
  }).strict()).max(16),
  observation: z.object({
    app: z.string(), windowId: z.string(), windowTitle: z.string().max(1000), surface: z.string(),
    // For tooling outside the model's view (the evaluation guard). The broker removes it from the prompt.
    nativeWindowId: z.string().max(200),
    complete: z.boolean(), scope: z.array(z.string().max(300)).max(50),
    outline: z.array(z.string().max(300)).max(60),
    windows: z.array(z.object({ id: z.string(), title: z.string().max(1000), focused: z.boolean() }).strict()).max(40),
    notices: z.array(z.string().max(1000)).max(12),
    capability: z.object({
      nodes: z.number().int(), actionable: z.number().int(), unlabeledActionable: z.number().int(),
      unreadRegions: z.number().int(), textFields: z.number().int(), readableTextFields: z.number().int(),
      focusedElement: z.boolean(), attributedText: z.literal('not_exposed'),
    }).strict(),
  }).strict(),
  elements: z.array(PlanElementSchema).max(120),
  scopes: z.array(z.object({ id: z.string().min(1).max(60), label: z.string().max(400) }).strict()).max(60),
  allowedKeys: z.array(z.string().max(40)).max(80),
  query: z.string().max(300),
  phase: z.enum(['planning', 'verification']),
  budgets: z.object({ stepsLeft: z.number().int().nullable(), verificationReadsLeft: z.number().int().nullable() }).strict(),
  issues: z.array(z.string().max(600)).max(8),
  mission: NavigationMissionSchema.optional(),
}).strict();
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export const PlanStepSchema = z.object({
  taskId: z.string(), observationId: z.string(), model: z.string(),
  requirements: z.array(z.object({ id: z.string().min(1).max(40), text: z.string().min(1).max(500),
    irreversible: z.boolean(),
    // text_entry: the obligation is only that given text ends up in a field or document.
    kind: z.enum(['outcome', 'text_entry']).default('outcome') }).strict()).max(12),
  reconciliations: z.array(z.object({ effectId: z.string(), outcome: z.enum(['confirmed', 'refuted']),
    evidence: z.array(z.string().max(40)).max(6) }).strict()).max(8),
  statuses: z.array(z.object({ requirementId: z.string(), status: z.enum(['open', 'evidenced', 'refuted']),
    evidence: z.array(z.string().max(40)).max(6),
    checks: z.array(z.object({ kind: z.enum(CHECK_KINDS), target: z.string().max(40),
      value: z.string().max(5000) }).strict()).max(4),
  }).strict()).max(12),
  kind: z.enum(['act', 'find', 'read', 'wait', 'ask_user', 'finish', 'blocked', 'yield']),
  requirementId: z.string().max(40),
  operation: z.union([z.enum(PLAN_OPERATIONS), z.literal('')]),
  target: z.string().max(40),
  targetDescription: z.string().max(400),
  text: z.string().max(5000),
  textIsLiteral: z.boolean(),
  key: z.string().max(40),
  direction: z.enum(['', 'up', 'down', 'left', 'right']),
  risk: z.enum(['reversible', 'irreversible']),
  repeat: z.boolean(),
  expect: z.string().max(500),
  query: z.string().max(300),
  scope: z.string().max(60),
  waitMs: z.number().int().min(0).max(5000),
  message: z.string().max(1000),
  report: NavigationReportSchema.nullable().optional(),
  usage: ModelUsageSchema.optional(),
}).strict();
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const GroundRequestSchema = z.object({
  taskId: z.string().uuid(), observationId: z.string().min(1), goal: z.string().min(1).max(1000),
  requirement: z.string().max(500), operation: z.enum(PLAN_OPERATIONS), text: z.string().max(600),
  key: z.string().max(40), targetDescription: z.string().max(400),
  elements: z.array(PlanElementSchema).min(1).max(250),
}).strict();
export type GroundRequest = z.infer<typeof GroundRequestSchema>;
export const GroundResultSchema = z.object({
  taskId: z.string(), observationId: z.string(), target: z.string(),
  confidence: z.number().min(0).max(1), model: z.string(),
  usage: ModelUsageSchema.optional(),
}).strict();
export type GroundResult = z.infer<typeof GroundResultSchema>;

export const OrchestratorRequestSchema = z.object({
  taskId: z.string().uuid(), goal: z.string().min(1).max(1000),
  answers: PlanRequestSchema.shape.answers,
  history: z.array(SemanticRecordSchema).optional(),
  requirements: PlanRequestSchema.shape.requirements,
  effects: z.array(z.object({ operation: z.string(), target: z.string().max(400), delivery: z.string(),
    outcome: z.string(), note: z.string().max(600),
    id: z.string().default(''), requirementId: z.string().default(''), text: z.string().max(600).default(''),
    readback: z.string().max(600).default(''), expect: z.string().max(500).default(''),
    readbackExpected: z.string().max(600).default(''),
    outcomeSource: z.enum(['none', 'planner', 'readback', 'postcondition']).default('none'),
    added: z.array(z.string().max(700)).max(12).default([]), removed: z.array(z.string().max(700)).max(12).default([]),
    scopeChanged: z.boolean().default(false) }).strict()).max(16),
  screen: z.object({ observationId: z.string().default(''), capturedAt: z.number().default(0),
    app: z.string(), title: z.string().max(1000), notices: z.array(z.string().max(1000)).max(12),
    elements: z.array(PlanElementSchema).max(60), scopes: PlanRequestSchema.shape.scopes,
    driver: z.string().default('native'), complete: z.boolean().default(false),
    allowedKeys: z.array(z.string().max(40)).max(80).default([]),
    exactUserText: z.array(z.string().max(5000)).max(8).default([]) }).strict(),
  sessions: z.array(z.object({ objective: z.string().max(1000), result: z.string().max(1500),
    steps: z.number().int().nonnegative() }).strict()).max(8),
  stepsLeft: z.number().int().nonnegative().nullable(),
  plan: z.array(NavigationMilestoneSchema).max(12).default([]),
  branches: z.array(BranchDecisionSchema).max(12).default([]),
  issues: z.array(z.string().max(1000)).max(8).default([]),
  handoff: z.object({
    outcome: z.string(), app: z.string(), windowTitle: z.string().max(1000), surface: z.string(),
    completionProposal: NavigationCompletionProposalSchema.optional(),
    milestoneId: z.string().default(''),
    windowId: z.string(),
    scope: z.array(z.string().max(300)).max(50), observationId: z.string(),
    completedRequirements: z.array(z.string()).max(12), unresolvedEffects: z.array(z.string()).max(16),
    remainingRequirements: z.array(z.string()).max(12),
    unresolvedEffectCount: z.number().int().nonnegative(),
    completion: z.enum(['verified', 'unverified', 'incomplete']),
    reason: z.string().max(1500), issues: z.array(z.string().max(1000)).max(8),
    attemptedScopes: z.array(z.string().max(300)).max(20),
    next: z.enum(['inspect_unresolved_effects', 'continue_remaining_work', 'verify_completion', 'inspect_or_report_unverified']),
  }).strict().optional(),
}).strict();
export type OrchestratorRequest = z.infer<typeof OrchestratorRequestSchema>;
export const OrchestratorResultSchema = z.object({
  taskId: z.string(), model: z.string(), kind: z.enum(['navigate', 'finish', 'finish_unverified', 'ask_user', 'blocked']),
  objective: z.string().max(1000), context: z.string().max(2500),
  doneWhen: z.string().max(1000).optional(),
  inputs: z.array(NavigationInputSchema).max(8).optional(),
  allowRepetition: z.boolean().optional(),
  message: z.string().max(1500), usage: ModelUsageSchema.optional(),
  plan: z.array(NavigationMilestoneSchema).max(12).default([]),
  milestoneId: z.string().max(40).default(''),
  branches: z.array(BranchDecisionSchema).max(12).default([]),
  reviews: z.array(MilestoneReviewSchema).max(1).default([]),
}).strict();
export type OrchestratorResult = z.infer<typeof OrchestratorResultSchema>;
