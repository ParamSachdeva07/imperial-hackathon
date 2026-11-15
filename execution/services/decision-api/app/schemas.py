"""What the broker reads from a request and what it accepts from a model.

Requests are defined once, in packages/contracts. The broker names only the fields it uses and
passes the rest to the model untouched. Model output is validated strictly here.
"""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Loose(BaseModel):
    model_config = ConfigDict(extra='allow')


class ModelUsage(Strict):
    provider: str
    inputTokens: int = Field(ge=0)
    outputTokens: int = Field(ge=0)
    cachedInputTokens: int = Field(default=0, ge=0)


# ---- Navigator ----
class Element(Loose):
    id: str
    operations: list[str] = []


class Scope(Loose):
    id: str


class EffectView(Loose):
    id: str
    outcome: str


class Mission(Loose):
    objective: str
    doneWhen: str = ''
    context: str = ''


class PlanRequest(Loose):
    taskId: str
    observationId: str
    goal: str
    mission: Mission
    elements: list[Element]
    scopes: list[Scope]
    effects: list[EffectView]


Operation = Literal['', 'CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE', 'FOCUS', 'SELECT',
                    'CHECK', 'UNCHECK', 'EXPAND', 'COLLAPSE', 'SCROLL', 'SCROLL_TO', 'PRESS', 'OPEN_APP', 'FOCUS_WINDOW',
                    'OPEN_URL', 'SEARCH_WEB']


class Reconciliation(Strict):
    effectId: str
    outcome: Literal['confirmed', 'refuted']
    evidence: list[str] = Field(max_length=6)


class Report(Strict):
    status: Literal['done', 'progress', 'needs_decision', 'blocked', 'unverified']
    summary: str = Field(max_length=1000)
    evidence: list[str] = Field(max_length=12)


class PlanWire(Strict):
    reconciliations: list[Reconciliation] = Field(max_length=8)
    kind: Literal['act', 'find', 'read', 'wait', 'yield']
    operation: Operation
    target: str
    text: str = Field(max_length=5000)
    key: str = Field(max_length=40)
    direction: Literal['', 'up', 'down', 'left', 'right']
    expect: str = Field(max_length=500)
    query: str = Field(max_length=300)
    scope: str
    waitMs: int = Field(ge=0, le=5000)
    report: Report | None


class PlanStep(PlanWire):
    taskId: str
    observationId: str
    model: str
    usage: ModelUsage | None = None


# ---- Luna ----
class OrchestratorRequest(Loose):
    taskId: str
    goal: str
    callerContext: str = ''
    plan: list[dict] = []
    history: list[dict] = []
    screen: dict


class PlanItem(Strict):
    text: str = Field(max_length=500)
    status: Literal['todo', 'done', 'skipped']


class OrchestratorWire(Strict):
    next: Literal['continue', 'finish', 'blocked']
    objective: str = Field(max_length=1000)
    doneWhen: str = Field(max_length=1000)
    context: str = Field(max_length=3000)
    plan: list[PlanItem] = Field(max_length=12)
    message: str = Field(max_length=1500)


class OrchestratorResult(OrchestratorWire):
    taskId: str
    model: str
    usage: ModelUsage | None = None
