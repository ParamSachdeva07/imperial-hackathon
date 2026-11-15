"""Loopback-only Anam token broker. The API key never leaves this process."""

import asyncio
import base64
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import hashlib
import hmac
import json
import os
from pathlib import Path
from time import monotonic, time
from urllib.parse import urlsplit
from uuid import UUID, uuid4

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
    # Lip-sync (ANAM_LIP_SYNC=1 with ANAM_AVATAR_ID): the avatar mouths audio it is sent; Anam runs no voice or model.
    lip_sync_avatar_id: str = ""
    avatar_model: str = ""
    # Synthesia interactive avatar (used when SYNTHESIA_API_KEY is set, unless AVATAR_PROVIDER=anam). Synthesia
    # renders the avatar into a LiveKit room of ours, so it needs that project's URL, key and secret too.
    synthesia_api_key: str = field(default="", repr=False)
    synthesia_api_base: str = "https://developers.synthesia.io"
    synthesia_avatar_id: str = ""
    livekit_url: str = ""
    livekit_api_key: str = field(default="", repr=False)
    livekit_api_secret: str = field(default="", repr=False)

    @classmethod
    def load(cls):
        # Explicit process variables take precedence. Never load this file in Electron.
        values = {**dotenv_values(ENV_PATH), **os.environ}
        return cls(
            api_key=(values.get("ANAM_API_KEY") or "").strip(),
            api_base=(values.get("ANAM_API_BASE") or "https://api.anam.ai").rstrip("/"),
            persona_id=(values.get("ANAM_PERSONA_ID") or "").strip(),
            lip_sync_avatar_id=(values.get("ANAM_AVATAR_ID") or "").strip() if values.get("ANAM_LIP_SYNC") == "1" else "",
            avatar_model=(values.get("ANAM_AVATAR_MODEL") or "").strip(),
            synthesia_api_key=("" if values.get("AVATAR_PROVIDER") == "anam" else (values.get("SYNTHESIA_API_KEY") or "").strip()),
            synthesia_api_base=(values.get("SYNTHESIA_API_URL") or "https://developers.synthesia.io").rstrip("/"),
            synthesia_avatar_id=(values.get("SYNTHESIA_AVATAR_ID") or "").strip(),
            livekit_url=(values.get("LIVEKIT_URL") or "").strip(),
            livekit_api_key=(values.get("LIVEKIT_API_KEY") or "").strip(),
            livekit_api_secret=(values.get("LIVEKIT_API_SECRET") or "").strip(),
        )

    @property
    def synthesia(self):
        return bool(self.synthesia_api_key)

    def validate_synthesia(self):
        missing = [name for name, value in (
            ("SYNTHESIA_AVATAR_ID", self.synthesia_avatar_id), ("LIVEKIT_URL", self.livekit_url),
            ("LIVEKIT_API_KEY", self.livekit_api_key), ("LIVEKIT_API_SECRET", self.livekit_api_secret),
        ) if not value or value.startswith(("<", "your-"))]
        if missing:
            raise HTTPException(503, f"Add {', '.join(missing)} to backend/.env, then retry.")
        if not self.livekit_url.startswith(("wss://", "ws://", "https://")):
            raise HTTPException(503, "LIVEKIT_URL must be your LiveKit project's wss:// address.")

    def livekit_ws_url(self):
        return "wss://" + self.livekit_url[len("https://"):] if self.livekit_url.startswith("https://") else self.livekit_url

    def persona_config(self):
        if not self.lip_sync_avatar_id:
            return {"personaId": self.persona_id}
        return {"avatarId": self.lip_sync_avatar_id, "enableAudioPassthrough": True,
                **({"avatarModel": self.avatar_model} if self.avatar_model else {})}

    def validate(self):
        if self.synthesia:
            return self.validate_synthesia()
        if not self.api_key or self.api_key.startswith(("<", "your-")):
            raise HTTPException(503, "Add ANAM_API_KEY to backend/.env, then retry.")
        base = urlsplit(self.api_base)
        if (base.scheme != "https" or not base.hostname or base.username
                or base.password or base.query or base.fragment or base.path not in ("", "/")):
            raise HTTPException(503, "ANAM_API_BASE must be an HTTPS origin, such as https://api.anam.ai.")
        try:
            UUID(self.lip_sync_avatar_id or self.persona_id)
        except (ValueError, TypeError, AttributeError):
            name = "ANAM_AVATAR_ID" if self.lip_sync_avatar_id else "ANAM_PERSONA_ID"
            raise HTTPException(503, f"Set a valid {name} in backend/.env.") from None


class SessionToken(BaseModel):
    sessionToken: str
    # Synthesia only: the LiveKit room to join with sessionToken, and the identity the avatar will join under.
    livekitUrl: str | None = None
    avatarIdentity: str | None = None


AVATAR_IDENTITY = "synthesia-avatar-agent"
DRIVER_IDENTITY = "avatar-window"


def livekit_jwt(config: Settings, claims: dict) -> str:
    def part(value: dict) -> bytes:
        return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=")
    now = int(time())
    claims = {"iss": config.livekit_api_key, "nbf": now - 10, "exp": now + 3600, **claims}
    signed = part({"alg": "HS256", "typ": "JWT"}) + b"." + part(claims)
    signature = hmac.new(config.livekit_api_secret.encode(), signed, hashlib.sha256).digest()
    return (signed + b"." + base64.urlsafe_b64encode(signature).rstrip(b"=")).decode()


def livekit_token(config: Settings, *, room: str, identity: str, name: str, attributes: dict[str, str] | None = None) -> str:
    """A LiveKit access token for one participant of one room. Both participants are agents:
    the window sends the voice audio, the avatar publishes video on the window's behalf."""
    return livekit_jwt(config, {
        "sub": identity, "name": name, "kind": "agent",
        "video": {"roomJoin": True, "room": room, "canPublish": True, "canSubscribe": True, "canPublishData": True},
        **({"attributes": attributes} if attributes else {}),
    })


async def close_room(application: FastAPI, config: Settings) -> None:
    """Delete the call's LiveKit room. This is what ends the Synthesia session: the avatar is a participant that
    would otherwise stay in the room, and keep its session running, after the window has left."""
    room = getattr(application.state, "room", None)
    application.state.room = None
    if not room:
        return
    try:
        await application.state.anam_http.post(
            config.livekit_ws_url().replace("wss://", "https://", 1).replace("ws://", "http://", 1) + "/twirp/livekit.RoomService/DeleteRoom",
            headers={"Authorization": f"Bearer {livekit_jwt(config, {'sub': 'backend', 'video': {'roomCreate': True}})}"},
            json={"room": room}, timeout=10.0)
    except httpx.HTTPError:
        pass  # the room also closes by itself once Synthesia's session times out


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None):
    attempts: deque[float] = deque()
    lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        async with httpx.AsyncClient(
            # Starting a Synthesia avatar only answers once the avatar is live in the room (they allow 75 s).
            timeout=httpx.Timeout(85.0, connect=5.0), follow_redirects=False,
            trust_env=False, transport=transport,
        ) as client:
            application.state.anam_http = client
            yield
            if (settings or Settings.load()).synthesia:
                await close_room(application, settings or Settings.load())  # never leave an avatar running after exit

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
        if config.synthesia:
            # The window joins this room first; POST /api/avatar-session then brings the avatar into it.
            await close_room(request.app, config)  # a call that ended without saying so
            room = f"call-{uuid4().hex}"
            request.app.state.room = room
            return SessionToken(
                sessionToken=livekit_token(config, room=room, identity=DRIVER_IDENTITY, name="Avatar window"),
                livekitUrl=config.livekit_ws_url(), avatarIdentity=AVATAR_IDENTITY)
        try:
            upstream = await request.app.state.anam_http.post(
                f"{config.api_base}/v1/auth/session-token", timeout=12.0,
                headers={"Authorization": f"Bearer {config.api_key}"},
                json={"personaConfig": config.persona_config()},
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

    async def interactive_avatar_id(request: Request, config: Settings) -> str:
        """The id sessions are started with. Synthesia turns a Studio avatar into an interactive one on request
        (slow the first time, then it returns the same one); the answer is remembered until the backend restarts.
        Studio shows the id with or without its av_ prefix, so both are accepted."""
        configured = config.synthesia_avatar_id
        if not configured.startswith("av_"):
            configured = f"av_{configured}"
        known = getattr(request.app.state, "interactive_avatar", None)
        if known and known[0] == configured:
            return known[1]
        try:
            upstream = await request.app.state.anam_http.post(
                f"{config.synthesia_api_base}/api/interactive-avatars/avatars",
                headers={"Authorization": f"Bearer {config.synthesia_api_key}"}, json={"sourceId": configured},
            )
        except httpx.HTTPError:
            raise HTTPException(502, "Cannot reach Synthesia. Check your internet connection.") from None
        try:
            data = upstream.json()
        except ValueError:
            data = {}
        if upstream.status_code == 404:
            return configured  # not a Studio avatar of this workspace: taken to be an interactive id already
        if not upstream.is_success:
            by_code = {"no_credit": "The Synthesia workspace has no interactive avatar credits.",
                       "insufficient_scope": "The Synthesia API key needs the Interactive Avatars (write) scope."}
            by_status = {401: "Synthesia rejected the API key. Check backend/.env."}
            raise HTTPException(502, by_code.get(data.get("code") if isinstance(data, dict) else None)
                                or by_status.get(upstream.status_code) or "Synthesia could not prepare the avatar.")
        status, avatar_id = data.get("status"), data.get("id")
        if status == "completed" and isinstance(avatar_id, str) and avatar_id:
            request.app.state.interactive_avatar = (configured, avatar_id)
            return avatar_id
        if data.get("done"):
            raise HTTPException(502, "Synthesia could not turn that avatar into an interactive one. Choose another avatar.")
        raise HTTPException(503, "Synthesia is still preparing the interactive avatar. Try again in a minute.")

    @application.post("/api/avatar-session")
    async def avatar_session(request: Request):
        """Start the Synthesia avatar in the room the last session token was issued for. Answers once it is live."""
        if request.headers.get("x-anam-overlay") != "1":
            raise HTTPException(403, "Use the desktop application to start a session.")
        config = settings or Settings.load()
        if not config.synthesia:
            raise HTTPException(404, "No Synthesia avatar is configured.")
        config.validate()
        room = getattr(request.app.state, "room", None)
        if not room:
            raise HTTPException(409, "No call is open.")
        avatar_id = await interactive_avatar_id(request, config)
        token = livekit_token(config, room=room, identity=AVATAR_IDENTITY, name="Synthesia avatar",
                              attributes={"lk.publish_on_behalf": DRIVER_IDENTITY})
        try:
            upstream = await request.app.state.anam_http.post(
                f"{config.synthesia_api_base}/api/interactive-avatars/sessions",
                headers={"Authorization": f"Bearer {config.synthesia_api_key}"},
                json={"avatarIds": [avatar_id], "livekitUrl": config.livekit_ws_url(), "livekitToken": token},
            )
        except httpx.TimeoutException:
            raise HTTPException(504, "The Synthesia avatar took too long to join. Please retry.") from None
        except httpx.HTTPError:
            raise HTTPException(502, "Cannot reach Synthesia. Check your internet connection.") from None
        if not upstream.is_success:
            try:
                code = upstream.json().get("code")
            except (ValueError, AttributeError):
                code = None
            messages = {
                "feature_not_in_plan": "Your Synthesia plan does not include interactive avatars.",
                "quota_exceeded": "Your Synthesia interactive avatar quota is used up.",
                "concurrency_limit": "Another Synthesia avatar session is still running. End it or wait, then retry.",
                "insufficient_scope": "The Synthesia API key needs the Interactive Avatars (write) scope.",
            }
            by_status = {401: "Synthesia rejected the API key. Check backend/.env.",
                         404: "Synthesia could not find that avatar. Check SYNTHESIA_AVATAR_ID (it starts with av_).",
                         409: "The call closed while the avatar was joining."}
            # Never relay upstream bodies; they can include credentials or internal details.
            raise HTTPException(429 if upstream.status_code == 429 else 502,
                                messages.get(code) or by_status.get(upstream.status_code)
                                or "Synthesia could not start the avatar. Please retry.")
        if getattr(request.app.state, "room", None) != room:
            # The call ended while the avatar was joining: take it out again.
            request.app.state.room = room
            await close_room(request.app, config)
            raise HTTPException(409, "The call closed while the avatar was joining.")
        return {"ok": True}

    @application.post("/api/avatar-session/end")
    async def avatar_session_end(request: Request):
        """The call is over: close its room so the avatar leaves and the Synthesia session ends."""
        if request.headers.get("x-anam-overlay") != "1":
            raise HTTPException(403, "Use the desktop application to end a session.")
        config = settings or Settings.load()
        if config.synthesia:
            await close_room(request.app, config)
        return {"ok": True}

    return application


app = create_app()
