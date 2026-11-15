from typing import Annotated, Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

class Bounds(StrictModel):
    x: float
    y: float
    width: float
    height: float

class Candidate(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    operation: Literal["SET_VALUE", "FOCUS", "CLICK"]
    targetRef: str = Field(pattern=r"^@[A-Za-z0-9]+:e\d+$")
    role: str
    name: str
    description: str
    inputId: Literal["document_text"] | None = None
    bounds: Bounds | None = None

class TextInput(StrictModel):
    id: Literal["document_text"]
    text: str = Field(min_length=1, max_length=5000)

class DecisionRequest(StrictModel):
    taskId: UUID
    step: int = Field(ge=1, le=12)
    snapshotId: str = Field(min_length=1)
    goal: str = Field(min_length=1, max_length=1000)
    app: Literal["TextEdit"]
    windowId: str = Field(min_length=1)
    input: TextInput
    candidates: list[Candidate] = Field(max_length=100)
    history: list[str] = Field(max_length=12)

class Decision(StrictModel):
    taskId: str
    snapshotId: str
    candidateId: str
    confidence: float = Field(ge=0, le=1)
    provider: Literal["jev"]
    model: str
    goalStatus: Literal["continue", "completed", "blocked"] | None = None
    goalConfidence: float | None = Field(default=None, ge=0, le=1)
    goalCompletionProbability: float | None = Field(default=None, ge=0, le=1)

class ScopeNode(StrictModel):
    ref: str
    name: str

class DesktopContext(StrictModel):
    driver: Literal['native', 'browser'] | None = None
    app: str | None = None
    windowId: str | None = None
    surface: str | None = None
    rootRef: str | None = None
    appSearch: str | None = None
    scopePath: list[ScopeNode] | None = Field(default=None, max_length=50)

class DesktopCandidate(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    operation: Literal['BROWSE_TREE', 'BROWSE_APPS', 'OPEN_APP', 'SEARCH_APPS', 'FOCUS_WINDOW', 'READ_WINDOW', 'READ_SURFACE', 'INSPECT_REGION', 'READ_BROWSER', 'NAVIGATE', 'BACK', 'FORWARD', 'WAIT', 'CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE', 'FOCUS', 'SELECT', 'CHECK', 'UNCHECK', 'EXPAND', 'COLLAPSE', 'SCROLL', 'SCROLL_TO', 'PRESS']
    description: str = Field(max_length=2000)
    name: str = Field(max_length=1000)
    app: str = Field(min_length=1, max_length=200)
    windowId: str | None = None
    snapshotId: str | None = None
    targetRef: str | None = Field(default=None, pattern=r'^@[A-Za-z0-9]+:e\d+$')
    role: str | None = None
    surface: str | None = None
    inputId: str | None = None
    inputFromGoal: bool | None = None
    key: str | None = None
    nodeId: str | None = None
    direction: Literal['up', 'down', 'left', 'right'] | None = None
    bounds: Bounds | None = None

class DesktopInput(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=5000)

class TreeObservation(StrictModel):
    id: str
    app: str
    windowId: str
    title: str
    surface: str
    complete: bool
    text: list[str] = Field(max_length=2200)

class TreePage(StrictModel):
    index: int = Field(ge=0)
    count: int = Field(ge=1)
    totalChoices: int = Field(ge=0)
    seen: list[int]

class GoalPhase(StrictModel):
    index: int = Field(ge=0)
    count: int = Field(ge=1)

class TreePathNode(StrictModel):
    id: str
    name: str

class TreePosition(StrictModel):
    view: Literal['tree', 'applications']
    path: list[TreePathNode]
    children: int = Field(ge=0)
    canGoUp: bool

class SupervisorTarget(StrictModel):
    app: str = Field(max_length=200)
    windowTitle: str = Field(max_length=1000)
    role: str = Field(max_length=200)
    name: str = Field(max_length=1000)
    windowId: str | None = Field(default=None, max_length=200)
    nativeId: str | None = Field(default=None, max_length=2000)
    nativeIdKind: str | None = Field(default=None, max_length=100)
    path: str | None = Field(default=None, max_length=4000)

class OutcomeCheck(StrictModel):
    kind: Literal['target_present', 'text_equals', 'state_present', 'state_absent', 'value_advances']
    target: SupervisorTarget
    value: str = Field(max_length=5000)

class ObservedTarget(SupervisorTarget):
    value: str
    states: list[str]

class ExpectedOutcome(StrictModel):
    kind: Literal['observed_state', 'text_equals', 'media_playing']
    description: str = Field(min_length=1, max_length=1000)
    target: SupervisorTarget
    value: str = Field(max_length=5000)
    checks: list[OutcomeCheck] = Field(max_length=12)

class SupervisorInput(StrictModel):
    id: str = Field(min_length=1, max_length=50)
    text: str = Field(min_length=1, max_length=5000)

class SupervisorPlan(StrictModel):
    status: Literal['continue', 'completed', 'blocked']
    subgoal: str = Field(min_length=1, max_length=1000)
    plan: list[Annotated[str, Field(min_length=1, max_length=1000)]] = Field(max_length=12)
    memory: list[Annotated[str, Field(min_length=1, max_length=1000)]] = Field(max_length=16)
    inputs: list[SupervisorInput] = Field(max_length=8)
    expectedOutcome: ExpectedOutcome
    evidence: list[Annotated[str, Field(min_length=1, max_length=2000)]] = Field(max_length=12)
    rationale: str = Field(min_length=1, max_length=2000)

class SupervisorGuidance(SupervisorPlan):
    taskId: str
    snapshotId: str

class ActionResult(StrictModel):
    operation: str
    target: str
    key: str | None = None
    text: str | None = None
    delivery: str
    verification: str
    before: list[str]
    after: list[str]
    scopeChanged: bool
    added: list[str]
    removed: list[str]

class DesktopDecisionRequest(StrictModel):
    mode: Literal['desktop']
    completionNeedsEvidence: bool = False
    actionResult: ActionResult | None = None
    observedTargets: list[ObservedTarget] = Field(default_factory=list, max_length=128)
    taskId: UUID
    step: int = Field(ge=1, le=500)
    snapshotId: str = Field(min_length=1)
    goal: str = Field(min_length=1, max_length=1000)
    context: DesktopContext
    overallGoal: str = Field(min_length=1, max_length=1000)
    phase: GoalPhase
    tree: TreePosition
    inputs: list[DesktopInput] = Field(max_length=8)
    observations: list[TreeObservation] = Field(max_length=3)
    candidates: list[DesktopCandidate] = Field(max_length=2500)
    history: list[str] = Field(max_length=40)
    notices: list[str] = Field(max_length=20)
    page: TreePage
    supervisor: SupervisorGuidance | None = None

class SupervisorRequest(StrictModel):
    taskId: UUID
    snapshotId: str = Field(min_length=1)
    step: int = Field(ge=1, le=500)
    goal: str = Field(min_length=1, max_length=1000)
    reason: Literal['initial', 'interval', 'no_progress', 'uncertain_action', 'completion', 'blocked', 'text_needed', 'interruption', 'action_result']
    observation: DesktopDecisionRequest
    previous: SupervisorGuidance | None
    issue: str = Field(default='', max_length=4000)

class TextTarget(StrictModel):
    app: str
    role: str
    name: str
    description: str = Field(max_length=2000)
    value: str = Field(max_length=2000)

class TextResolutionRequest(StrictModel):
    taskId: UUID
    snapshotId: str = Field(min_length=1)
    candidateId: str = Field(min_length=1)
    goal: str = Field(min_length=1, max_length=1000)
    purpose: Literal['field_text', 'app_name']
    target: TextTarget
    history: list[str] = Field(max_length=10)

class TextResolution(StrictModel):
    taskId: str
    snapshotId: str
    candidateId: str
    status: Literal['resolved', 'unavailable']
    text: str = Field(max_length=1000)
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    confidence: float = Field(ge=0, le=1)
    supportConfidence: float = Field(ge=0, le=1)
    reason: Literal['no_span', 'invalid_boundaries', 'unsupported'] | None = None
    proposedText: str | None = None
    model: str


# ---- v2 planner contracts (docs/controller-redesign.md) ----
PlanOperation = Literal['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE', 'FOCUS',
                        'SELECT', 'CHECK', 'UNCHECK', 'EXPAND', 'COLLAPSE', 'SCROLL', 'SCROLL_TO', 'PRESS',
                        'OPEN_APP', 'FOCUS_WINDOW', 'OPEN_URL']
CheckKind = Literal['target_present', 'text_equals', 'state_present', 'state_absent', 'value_advances']


class PlanElement(StrictModel):
    id: str = Field(min_length=1, max_length=40)
    role: str = Field(max_length=100)
    label: str = Field(max_length=400)
    value: str = Field(max_length=600)
    states: list[Annotated[str, Field(max_length=60)]] = Field(max_length=20)
    path: str = Field(max_length=600)
    operations: list[PlanOperation] = Field(max_length=20)
    tags: list[Annotated[str, Field(max_length=40)]] = Field(max_length=8)


class PlanAnswer(StrictModel):
    question: str = Field(max_length=1000)
    answer: str = Field(max_length=1000)


class PlanRequirementState(StrictModel):
    id: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=500)
    irreversible: bool
    kind: Literal['outcome', 'text_entry']
    status: Literal['open', 'evidenced', 'refuted', 'unverifiable']
    evidence: list[Annotated[str, Field(max_length=700)]] = Field(max_length=6)


class PlanEffect(StrictModel):
    id: str
    step: int
    requirementId: str
    operation: str
    target: str = Field(max_length=400)
    text: str | None = Field(default=None, max_length=600)
    key: str | None = None
    direction: str | None = None
    risk: str
    delivery: str
    outcome: str
    expect: str = Field(max_length=500)
    readback: str | None = Field(default=None, max_length=600)
    added: list[Annotated[str, Field(max_length=700)]] = Field(max_length=12)
    removed: list[Annotated[str, Field(max_length=700)]] = Field(max_length=12)
    scopeChanged: bool
    note: str = Field(max_length=500)


class PlanWindow(StrictModel):
    id: str
    title: str = Field(max_length=1000)
    focused: bool


class PlanCapability(StrictModel):
    nodes: int
    actionable: int
    unlabeledActionable: int
    unreadRegions: int
    textFields: int
    readableTextFields: int
    focusedElement: bool
    attributedText: Literal['not_exposed']


class PlanObservation(StrictModel):
    app: str
    windowId: str
    nativeWindowId: str = Field(max_length=200)
    windowTitle: str = Field(max_length=1000)
    surface: str
    complete: bool
    scope: list[Annotated[str, Field(max_length=300)]] = Field(max_length=50)
    outline: list[Annotated[str, Field(max_length=300)]] = Field(max_length=60)
    windows: list[PlanWindow] = Field(max_length=40)
    notices: list[Annotated[str, Field(max_length=1000)]] = Field(max_length=12)
    capability: PlanCapability


class PlanScope(StrictModel):
    id: str = Field(min_length=1, max_length=60)
    label: str = Field(max_length=400)


class PlanBudgets(StrictModel):
    stepsLeft: int | None
    verificationReadsLeft: int | None


class ModelUsage(StrictModel):
    provider: str
    inputTokens: int = Field(ge=0)
    outputTokens: int = Field(ge=0)
    cachedInputTokens: int = Field(default=0, ge=0)


class NavigationMilestone(StrictModel):
    id: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=500)
    doneWhen: str = Field(min_length=1, max_length=500)
    condition: str = Field(max_length=500)
    dependsOn: list[Annotated[str, Field(min_length=1, max_length=40)]] = Field(max_length=12)
    kind: Literal['outcome', 'text_entry']
    irreversible: bool


class BranchDecision(StrictModel):
    milestoneId: str = Field(min_length=1, max_length=40)
    disposition: Literal['run', 'skip']
    sourceMilestoneIds: list[Annotated[str, Field(min_length=1, max_length=40)]] = Field(min_length=1, max_length=12)
    reason: str = Field(min_length=1, max_length=500)


class MilestoneReview(StrictModel):
    milestoneId: str = Field(min_length=1, max_length=40)
    # Keep the schema stable for prefix caching; live membership is checked by the controller.
    evidence: list[Annotated[str, Field(min_length=1, max_length=40, pattern=r'^[A-Za-z0-9_-]+$')]] = Field(min_length=1, max_length=6)
    status: Literal['evidenced', 'open', 'unverifiable']
    reason: str = Field(max_length=1000)


class NavigationInput(StrictModel):
    name: str = Field(max_length=80)
    value: str = Field(max_length=5000)


class SemanticRecord(StrictModel):
    taskId: str
    kind: Literal['instruction', 'assignment', 'result', 'decision', 'correction', 'checkpoint']
    summary: str = Field(max_length=6000)
    inputs: list[NavigationInput] = Field(default_factory=list, max_length=32)
    facts: list[Annotated[str, Field(max_length=1000)]] = Field(default_factory=list, max_length=80)


class NavigationReport(StrictModel):
    status: Literal['progress', 'objective_met', 'needs_decision', 'blocked', 'unverified']
    summary: str = Field(max_length=1000)
    evidence: list[Annotated[str, Field(max_length=40)]] = Field(max_length=12)
    remaining: list[Annotated[str, Field(max_length=500)]] = Field(max_length=8)


class NavigationMission(StrictModel):
    objective: str = Field(min_length=1, max_length=1000)
    context: str = Field(max_length=2500)
    doneWhen: str = Field(default='', max_length=1000)
    inputs: list[NavigationInput] = Field(default_factory=list, max_length=8)
    allowRepetition: bool = False
    milestone: NavigationMilestone | None = None


class PlanRequest(StrictModel):
    taskId: UUID
    observationId: str = Field(min_length=1)
    step: int = Field(ge=1, le=500)
    goal: str = Field(min_length=1, max_length=1000)
    literals: list[Annotated[str, Field(max_length=5000)]] = Field(max_length=8)
    answers: list[PlanAnswer] = Field(max_length=8)
    requirements: list[PlanRequirementState] = Field(max_length=12)
    effects: list[PlanEffect] = Field(max_length=16)
    observation: PlanObservation
    elements: list[PlanElement] = Field(max_length=120)
    scopes: list[PlanScope] = Field(max_length=60)
    allowedKeys: list[Annotated[str, Field(max_length=40)]] = Field(max_length=80)
    query: str = Field(max_length=300)
    phase: Literal['planning', 'verification']
    budgets: PlanBudgets
    issues: list[Annotated[str, Field(max_length=600)]] = Field(max_length=8)
    mission: NavigationMission | None = None


class PlanRequirementDecl(StrictModel):
    id: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=500)
    irreversible: bool
    kind: Literal['outcome', 'text_entry']


class PlanReconciliation(StrictModel):
    effectId: str
    outcome: Literal['confirmed', 'refuted']
    evidence: list[Annotated[str, Field(max_length=40)]] = Field(max_length=6)


class PlanCheck(StrictModel):
    kind: CheckKind
    target: str = Field(max_length=40)
    value: str = Field(max_length=5000)


class PlanStatus(StrictModel):
    requirementId: str
    status: Literal['open', 'evidenced', 'refuted']
    evidence: list[Annotated[str, Field(max_length=40)]] = Field(max_length=6)
    checks: list[PlanCheck] = Field(max_length=4)


class PlanWire(StrictModel):
    """What the planning model returns. Identifiers are bound by the broker."""
    requirements: list[PlanRequirementDecl] = Field(max_length=12)
    reconciliations: list[PlanReconciliation] = Field(max_length=8)
    statuses: list[PlanStatus] = Field(max_length=12)
    kind: Literal['act', 'find', 'read', 'wait', 'ask_user', 'finish', 'blocked', 'yield']
    requirementId: str = Field(max_length=40)
    operation: PlanOperation | Literal['']
    target: str = Field(max_length=40)
    targetDescription: str = Field(max_length=400)
    text: str = Field(max_length=5000)
    textIsLiteral: bool
    key: str = Field(max_length=40)
    direction: Literal['', 'up', 'down', 'left', 'right']
    risk: Literal['reversible', 'irreversible']
    repeat: bool
    expect: str = Field(max_length=500)
    query: str = Field(max_length=300)
    scope: str = Field(max_length=60)
    waitMs: int = Field(ge=0, le=5000)
    message: str = Field(max_length=1000)
    report: NavigationReport | None


class PlanStep(PlanWire):
    taskId: str
    observationId: str
    model: str
    usage: ModelUsage | None = None


class GroundRequest(StrictModel):
    taskId: UUID
    observationId: str = Field(min_length=1)
    goal: str = Field(min_length=1, max_length=1000)
    requirement: str = Field(max_length=500)
    operation: PlanOperation
    text: str = Field(max_length=600)
    key: str = Field(max_length=40)
    targetDescription: str = Field(max_length=400)
    elements: list[PlanElement] = Field(min_length=1, max_length=250)


class GroundResult(StrictModel):
    taskId: str
    observationId: str
    target: str
    confidence: float = Field(ge=0, le=1)
    model: str
    usage: ModelUsage | None = None


class OrchestratorEffect(StrictModel):
    operation: str
    target: str = Field(max_length=400)
    delivery: str
    outcome: str
    note: str = Field(max_length=600)
    id: str = ''
    requirementId: str = ''
    text: str = Field(default='', max_length=600)
    readback: str = Field(default='', max_length=600)
    readbackExpected: str = Field(default='', max_length=600)
    outcomeSource: Literal['none', 'planner', 'readback', 'postcondition'] = 'none'
    expect: str = Field(default='', max_length=500)
    added: list[Annotated[str, Field(max_length=700)]] = Field(default_factory=list, max_length=12)
    removed: list[Annotated[str, Field(max_length=700)]] = Field(default_factory=list, max_length=12)
    scopeChanged: bool = False


class OrchestratorScreen(StrictModel):
    observationId: str = ''
    capturedAt: float = 0
    app: str
    title: str = Field(max_length=1000)
    notices: list[Annotated[str, Field(max_length=1000)]] = Field(max_length=12)
    elements: list[PlanElement] = Field(max_length=60)
    scopes: list[PlanScope] = Field(max_length=60)
    driver: str = 'native'
    complete: bool = False
    allowedKeys: list[Annotated[str, Field(max_length=40)]] = Field(default_factory=list, max_length=80)
    exactUserText: list[Annotated[str, Field(max_length=5000)]] = Field(default_factory=list, max_length=8)


class NavigationSessionResult(StrictModel):
    objective: str = Field(max_length=1000)
    result: str = Field(max_length=1500)
    steps: int = Field(ge=0)


class NavigationCompletionProposal(StrictModel):
    milestoneId: str = Field(min_length=1, max_length=40)
    observationId: str
    summary: str = Field(max_length=1000)
    evidence: list[Annotated[str, Field(max_length=700)]] = Field(max_length=6)


class NavigationHandoff(StrictModel):
    outcome: str
    completionProposal: NavigationCompletionProposal | None = None
    milestoneId: str = ''
    app: str
    windowTitle: str = Field(max_length=1000)
    surface: str
    windowId: str
    scope: list[Annotated[str, Field(max_length=300)]] = Field(max_length=50)
    observationId: str
    completedRequirements: list[str] = Field(max_length=12)
    unresolvedEffects: list[str] = Field(max_length=16)
    remainingRequirements: list[str] = Field(max_length=12)
    unresolvedEffectCount: int = Field(ge=0)
    completion: Literal['verified', 'unverified', 'incomplete']
    reason: str = Field(max_length=1500)
    issues: list[Annotated[str, Field(max_length=1000)]] = Field(max_length=8)
    attemptedScopes: list[Annotated[str, Field(max_length=300)]] = Field(max_length=20)
    next: Literal['inspect_unresolved_effects', 'continue_remaining_work', 'verify_completion', 'inspect_or_report_unverified']


class OrchestratorRequest(StrictModel):
    taskId: UUID
    goal: str = Field(min_length=1, max_length=1000)
    answers: list[PlanAnswer] = Field(max_length=8)
    history: list[SemanticRecord] = Field(default_factory=list)
    requirements: list[PlanRequirementState] = Field(max_length=12)
    effects: list[OrchestratorEffect] = Field(max_length=16)
    screen: OrchestratorScreen
    sessions: list[NavigationSessionResult] = Field(max_length=8)
    stepsLeft: int | None = Field(ge=0)
    handoff: NavigationHandoff | None = None
    plan: list[NavigationMilestone] = Field(default_factory=list, max_length=12)
    branches: list[BranchDecision] = Field(default_factory=list, max_length=12)
    issues: list[Annotated[str, Field(max_length=1000)]] = Field(default_factory=list, max_length=8)


class OrchestratorWire(StrictModel):
    plan: list[NavigationMilestone] = Field(max_length=12)
    reviews: list[MilestoneReview] = Field(max_length=1)
    branches: list[BranchDecision] = Field(max_length=12)
    milestoneId: str = Field(max_length=40)
    kind: Literal['navigate', 'finish', 'finish_unverified', 'blocked']
    objective: str = Field(max_length=1000)
    context: str = Field(max_length=2500)
    doneWhen: str = Field(max_length=1000)
    inputs: list[NavigationInput] = Field(max_length=8)
    allowRepetition: bool
    message: str = Field(max_length=1500)


class OrchestratorResult(OrchestratorWire):
    taskId: str
    model: str
    usage: ModelUsage | None = None
