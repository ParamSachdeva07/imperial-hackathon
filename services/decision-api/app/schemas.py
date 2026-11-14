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
