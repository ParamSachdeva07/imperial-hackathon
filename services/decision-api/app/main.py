import os
import secrets
from contextlib import asynccontextmanager
import httpx
from pathlib import Path
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from dotenv import load_dotenv
from .schemas import DecisionRequest, DesktopDecisionRequest, Decision, TextResolutionRequest, TextResolution, SupervisorRequest, SupervisorGuidance
from .jev import choose, DecisionError
from .text_resolution import resolve_text
from .supervisor import supervise, SupervisorError
from .supervisor_providers import configuration

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

@asynccontextmanager
async def lifespan(application: FastAPI):
    # Reuse the connection pool across supervisor reviews instead of reconnecting.
    async with httpx.AsyncClient(timeout=55.0, limits=httpx.Limits(keepalive_expiry=60.0)) as client:
        application.state.supervisor_client = client
        yield
    application.state.supervisor_client = None

app = FastAPI(title="Desktop Assistant decision broker", version="0.1.0", docs_url=None, redoc_url=None, lifespan=lifespan)
bearer = HTTPBearer(auto_error=False)

def authorize(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
    expected = os.environ.get("DECISION_API_TOKEN", "")
    if not expected:
        raise HTTPException(503, "Decision broker requires an application token.")
    if not credentials or not secrets.compare_digest(credentials.credentials, expected):
        raise HTTPException(401, "Invalid application token.")

@app.get("/health", dependencies=[Depends(authorize)])
def health():
    try:
        config = configuration()
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc
    return {
        "status": "ok",
        "keyConfigured": bool(os.environ.get("TYPESAFE_API_KEY", "").strip()),
        "model": os.environ.get("TYPESAFE_MODEL", "jev-latest"),
        "supervisorConfigured": bool(config.key),
        "supervisorProvider": config.provider,
        "supervisorModel": config.model,
        "supervisorReasoningEffort": config.reasoning_effort,
        "supervisorServiceTier": config.service_tier,
    }

@app.post("/navigation/decide", response_model=Decision, response_model_exclude_none=True, dependencies=[Depends(authorize)])
async def decide(request: DecisionRequest | DesktopDecisionRequest):
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        raise HTTPException(503, "Add TYPESAFE_API_KEY to services/decision-api/.env and restart the app.")
    try:
        return await choose(request, key, os.environ.get("TYPESAFE_MODEL", "jev-latest"))
    except DecisionError as exc:
        raise HTTPException(502, str(exc)) from exc

@app.post('/navigation/resolve-text', response_model=TextResolution, dependencies=[Depends(authorize)])
async def resolve_input(request: TextResolutionRequest):
    key = os.environ.get('TYPESAFE_API_KEY', '').strip()
    if not key:
        raise HTTPException(503, 'Add TYPESAFE_API_KEY to services/decision-api/.env and restart the app.')
    try:
        return await resolve_text(request, key, os.environ.get('TYPESAFE_MODEL', 'jev-latest'))
    except DecisionError as exc:
        raise HTTPException(502, str(exc)) from exc

@app.post('/navigation/supervise', response_model=SupervisorGuidance, response_model_exclude_none=True, dependencies=[Depends(authorize)])
async def supervise_navigation(request: SupervisorRequest):
    try:
        config = configuration()
    except ValueError as exc:
        raise HTTPException(503, str(exc)) from exc
    if not config.key:
        raise HTTPException(503, f'Add {config.provider.upper()}_API_KEY to services/decision-api/.env for the supervisor and restart the app.')
    try:
        return await supervise(request, config.key, config.model, provider=config.provider,
            client=getattr(app.state, 'supervisor_client', None),
            reasoning_effort=config.reasoning_effort, service_tier=config.service_tier)
    except SupervisorError as exc:
        raise HTTPException(502, str(exc)) from exc
