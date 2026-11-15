import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from .navigator import plan
from .orchestrator import orchestrate
from .providers import ModelConfig, ModelError, configuration
from .schemas import OrchestratorRequest, OrchestratorResult, PlanRequest, PlanStep

load_dotenv(Path(__file__).resolve().parents[1] / ".env")


@asynccontextmanager
async def lifespan(application: FastAPI):
    # One connection pool for every model call instead of reconnecting each time.
    async with httpx.AsyncClient(limits=httpx.Limits(keepalive_expiry=60.0)) as client:
        application.state.client = client
        yield
    application.state.client = None

app = FastAPI(title="Desktop Assistant decision broker", version="0.2.0", docs_url=None, redoc_url=None, lifespan=lifespan)
bearer = HTTPBearer(auto_error=False)


def authorize(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
    expected = os.environ.get("DECISION_API_TOKEN", "")
    if not expected:
        raise HTTPException(503, "Decision broker requires an application token.")
    if not credentials or not secrets.compare_digest(credentials.credentials, expected):
        raise HTTPException(401, "Invalid application token.")


def configured(role: str) -> ModelConfig:
    try:
        config = configuration(role)
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc
    if not config.key:
        raise HTTPException(503, f'Add {config.provider.upper()}_API_KEY to services/decision-api/.env for the {role} and restart the app.')
    return config


async def answer(call):
    # The desktop client retries transient provider failures; model calls send no desktop input.
    try:
        return await call
    except ModelError as exc:
        raise HTTPException(502, str(exc), headers={'X-Retryable': '1' if exc.retryable else '0'}) from exc


@app.get("/health", dependencies=[Depends(authorize)])
def health():
    try:
        navigator, luna = configuration('navigator'), configuration('orchestrator')
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc
    return {"navigatorConfigured": bool(navigator.key), "navigatorProvider": navigator.provider, "navigatorModel": navigator.model,
            "orchestratorConfigured": bool(luna.key), "orchestratorProvider": luna.provider, "orchestratorModel": luna.model}


@app.post('/navigation/plan', response_model=PlanStep, response_model_exclude_none=True, dependencies=[Depends(authorize)])
async def plan_step(request: PlanRequest):
    return await answer(plan(request, configured('navigator'), getattr(app.state, 'client', None)))


@app.post('/navigation/orchestrate', response_model=OrchestratorResult, response_model_exclude_none=True, dependencies=[Depends(authorize)])
async def orchestrate_task(request: OrchestratorRequest):
    return await answer(orchestrate(request, configured('orchestrator'), getattr(app.state, 'client', None)))
