import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.main import Settings, create_app

SECRET = "test-secret-never-return-this"
PERSONA = "ec3b8e17-2ff7-517d-92e5-c13a3a865023"
HEADERS = {"X-Anam-Overlay": "1"}


def client(handler, settings=None):
    return TestClient(create_app(settings or Settings(api_key=SECRET), httpx.MockTransport(handler)),
                      base_url="http://127.0.0.1:8765")


def test_saved_persona_only_and_secret_never_returned():
    requests = []

    def upstream(request):
        requests.append(request)
        return httpx.Response(200, json={"sessionToken": "temporary-token", "apiKey": SECRET})

    with client(upstream) as app:
        response = app.post("/api/session-token", headers=HEADERS,
                            json={"personaConfig": {"personaId": "attacker-override"}})
        assert response.status_code == 200
        assert response.json() == {"sessionToken": "temporary-token"}
        assert response.headers["cache-control"] == "no-store"
        assert SECRET not in response.text
        assert len(requests) == 1
        assert str(requests[0].url) == "https://api.anam.ai/v1/auth/session-token"
        assert requests[0].headers["authorization"] == f"Bearer {SECRET}"
        assert json.loads(requests[0].content) == {"personaConfig": {"personaId": PERSONA}}


def test_missing_key_and_health_are_safe():
    def forbidden(_):
        pytest.fail("Missing configuration must never call Anam")

    with client(forbidden, Settings(api_key="")) as app:
        assert app.get("/health").json() == {"status": "ok", "configured": False}
        response = app.post("/api/session-token", headers=HEADERS)
        assert response.status_code == 503
        assert "backend/.env" in response.json()["detail"]


@pytest.mark.parametrize("settings", [
    Settings(api_key=SECRET, api_base="http://api.anam.ai"),
    Settings(api_key=SECRET, api_base="https://user:pass@api.anam.ai"),
    Settings(api_key=SECRET, api_base="https://api.anam.ai?key=oops"),
    Settings(api_key=SECRET, persona_id="invalid"),
])
def test_invalid_configuration(settings):
    with client(lambda _: pytest.fail("Invalid config must not make requests"), settings) as app:
        assert app.post("/api/session-token", headers=HEADERS).status_code == 503


@pytest.mark.parametrize("headers, expected", [
    ({}, 403),
    ({**HEADERS, "Origin": "https://evil.example"}, 403),
    ({**HEADERS, "Origin": "null"}, 403),
    ({**HEADERS, "Sec-Fetch-Site": "cross-site"}, 403),
    ({**HEADERS, "Host": "evil.example"}, 400),
])
def test_reject_browser_requests_and_untrusted_hosts(headers, expected):
    with client(lambda _: pytest.fail("Rejected requests must not reach Anam")) as app:
        response = app.post("/api/session-token", headers=headers)
        assert response.status_code == expected
        assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize("status", [301, 401, 403, 404, 429, 500])
def test_upstream_failures_do_not_leak_bodies(status):
    with client(lambda _: httpx.Response(status, text=SECRET)) as app:
        response = app.post("/api/session-token", headers=HEADERS)
        assert response.status_code == (429 if status == 429 else 502)
        assert SECRET not in response.text


@pytest.mark.parametrize("body", [{}, {"sessionToken": ""}, {"sessionToken": 42}, []])
def test_invalid_upstream_payload(body):
    with client(lambda _: httpx.Response(200, json=body)) as app:
        assert app.post("/api/session-token", headers=HEADERS).status_code == 502


def test_malformed_json():
    with client(lambda _: httpx.Response(200, text="not json")) as app:
        assert app.post("/api/session-token", headers=HEADERS).status_code == 502


@pytest.mark.parametrize("exception, status", [(httpx.ReadTimeout, 504), (httpx.ConnectError, 502)])
def test_network_failure(exception, status):
    def upstream(_):
        raise exception(SECRET)

    with client(upstream) as app:
        response = app.post("/api/session-token", headers=HEADERS)
        assert response.status_code == status
        assert SECRET not in response.text


def test_rate_limit():
    with client(lambda _: httpx.Response(200, json={"sessionToken": "temporary"})) as app:
        for _ in range(6):
            assert app.post("/api/session-token", headers=HEADERS).status_code == 200
        response = app.post("/api/session-token", headers=HEADERS)
        assert response.status_code == 429
        assert response.headers["retry-after"] == "60"


def test_elevenlabs_agent_mode_fetches_a_signed_url_and_never_returns_either_key():
    requests = []
    eleven = "eleven-secret-never-return-this"

    def upstream(request):
        requests.append(request)
        if request.url.host == "api.elevenlabs.io":
            return httpx.Response(200, json={"signed_url": "wss://signed.example/agent"})
        return httpx.Response(200, json={"sessionToken": "temporary-token"})

    settings = Settings(api_key=SECRET, elevenlabs_api_key=eleven, elevenlabs_agent_id="agent_123", avatar_id="avatar_abc")
    with client(upstream, settings) as app:
        response = app.post("/api/session-token", headers=HEADERS)
        assert response.json() == {"sessionToken": "temporary-token"}
        assert SECRET not in response.text and eleven not in response.text
        assert requests[0].url.params["agent_id"] == "agent_123"
        assert requests[0].headers["xi-api-key"] == eleven
        assert "authorization" not in requests[0].headers
        assert json.loads(requests[1].content) == {
            "personaConfig": {"avatarId": "avatar_abc", "avatarModel": "cara-4"},
            "environment": {"elevenLabsAgentSettings": {"signedUrl": "wss://signed.example/agent", "agentId": "agent_123"}},
        }


def test_elevenlabs_failure_is_reported_without_reaching_anam():
    requests = []

    def upstream(request):
        requests.append(request)
        return httpx.Response(401, json={"detail": "bad key"})

    settings = Settings(api_key=SECRET, elevenlabs_api_key="k", elevenlabs_agent_id="agent_123", avatar_id="avatar_abc")
    with client(upstream, settings) as app:
        response = app.post("/api/session-token", headers=HEADERS)
        assert response.status_code == 502 and "ElevenLabs" in response.json()["detail"]
        assert len(requests) == 1
