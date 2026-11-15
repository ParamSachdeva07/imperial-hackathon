"""Loopback-only Anam token broker. The API key never leaves this process."""

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import os
from pathlib import Path
from time import monotonic
from urllib.parse import urlsplit
from uuid import UUID

from dotenv import dotenv_values
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import httpx
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

ENV_PATH = Path(__file__).resolve().with_name(".env")


@dataclass(frozen=True)
class Settings:
    api_key: str = field(default="", repr=False)
    api_base: str = "https://api.anam.ai"
    persona_id: str = "ec3b8e17-2ff7-517d-92e5-c13a3a865023"

    @classmethod
    def load(cls):
        # Explicit process variables take precedence. Never load this file in Electron.
        values = {**dotenv_values(ENV_PATH), **os.environ}
        return cls(
            api_key=(values.get("ANAM_API_KEY") or "").strip(),
            api_base=(values.get("ANAM_API_BASE") or "https://api.anam.ai").rstrip("/"),
            persona_id=(values.get("ANAM_PERSONA_ID") or "").strip(),
        )

    def validate(self):
        if not self.api_key or self.api_key.startswith(("<", "your-")):
            raise HTTPException(503, "Add ANAM_API_KEY to backend/.env, then retry.")
        base = urlsplit(self.api_base)
        if (base.scheme != "https" or not base.hostname or base.username
                or base.password or base.query or base.fragment or base.path not in ("", "/")):
            raise HTTPException(503, "ANAM_API_BASE must be an HTTPS origin, such as https://api.anam.ai.")
        try:
            UUID(self.persona_id)
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(503, "Set a valid ANAM_PERSONA_ID in backend/.env.") from None


class SessionToken(BaseModel):
    sessionToken: str


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None):
    attempts: deque[float] = deque()
    lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=5.0), follow_redirects=False,
            trust_env=False, transport=transport,
        ) as client:
            application.state.anam_http = client
            yield

    application = FastAPI(title="Anam Overlay", lifespan=lifespan, docs_url=None, redoc_url=None)
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    @application.middleware("http")
    async def local_only(request: Request, call_next):
        # The Electron main process sends no Origin. Browser callers get no CORS grant.
        if request.headers.get("origin") or request.headers.get("sec-fetch-site") == "cross-site":
            response = JSONResponse({"detail": "Browser origins are not allowed."}, status_code=403)
        elif request.url.path == "/api/session-token" and request.headers.get("x-anam-overlay") != "1":
            response = JSONResponse({"detail": "Use the desktop application to start a session."}, status_code=403)
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @application.get("/health")
    async def health():
        try:
            (settings or Settings.load()).validate()
            configured = True
        except HTTPException:
            configured = False
        return {"status": "ok", "configured": configured}

    @application.post("/api/session-token", response_model=SessionToken)
    async def session_token(request: Request):
        config = settings or Settings.load()
        config.validate()
        async with lock:
            now = monotonic()
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
            if len(attempts) >= 6:
                raise HTTPException(429, "Too many connection attempts. Retry in a minute.", headers={"Retry-After": "60"})
            attempts.append(now)
        try:
            upstream = await request.app.state.anam_http.post(
                f"{config.api_base}/v1/auth/session-token",
                headers={"Authorization": f"Bearer {config.api_key}"},
                json={"personaConfig": {"personaId": config.persona_id}},
            )
        except httpx.TimeoutException:
            raise HTTPException(504, "Anam took too long to respond. Please retry.") from None
        except httpx.HTTPError:
            raise HTTPException(502, "Cannot reach Anam. Check your internet connection.") from None
        if not upstream.is_success:
            messages = {
                401: "Anam rejected the API key. Check backend/.env.",
                403: "The API key cannot access this Anam persona.",
                404: "Anam could not find the saved persona. Check ANAM_PERSONA_ID.",
                429: "Anam is rate limiting requests. Please wait and retry.",
            }
            # Never relay upstream bodies; they can include credentials or internal details.
            raise HTTPException(429 if upstream.status_code == 429 else 502,
                                messages.get(upstream.status_code, "Anam could not create a session. Please retry."))
        try:
            data = upstream.json()
        except ValueError:
            raise HTTPException(502, "Anam returned an invalid session response.") from None
        token = data.get("sessionToken") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token.strip():
            raise HTTPException(502, "Anam returned no session token.")
        return SessionToken(sessionToken=token)

    return application


app = create_app()
