import asyncio
import json
import httpx
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.schemas import DecisionRequest
from app.jev import choose, DecisionError

def request_data():
    return {
        "taskId": "9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe", "step": 1,
        "snapshotId": "s1", "goal": "Enter the supplied text.", "app": "TextEdit", "windowId": "w-1",
        "input": {"id": "document_text", "text": "Hello Alex\n$HOME $(not-a-command)"},
        "candidates": [{
            "id": "write_document", "operation": "SET_VALUE", "targetRef": "@s1:e1",
            "role": "textfield", "name": "Document body", "description": "Set exact supplied text.", "inputId": "document_text"
        }], "history": [],
    }

@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("DECISION_API_TOKEN", "test-app-token")
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    return TestClient(app)

def test_authentication_required(client):
    assert client.post("/navigation/decide", json=request_data()).status_code == 401

def test_missing_provider_key_is_explicit(client):
    response = client.post("/navigation/decide", json=request_data(), headers={"Authorization": "Bearer test-app-token"})
    assert response.status_code == 503
    assert "TYPESAFE_API_KEY" in response.json()["detail"]

def test_key_never_returned_from_health(client, monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "secret-fixture-key")
    response = client.get("/health", headers={"Authorization": "Bearer test-app-token"})
    assert response.json()["keyConfigured"] is True
    assert "secret-fixture-key" not in response.text

def test_real_provider_contract_and_exact_text():
    expected = request_data()
    def upstream(request):
        assert str(request.url) == "https://api.typesafe.ai/v1/systemone"
        assert request.headers["Authorization"] == "Bearer server-only-key"
        body = json.loads(request.content)
        assert body["state"]["input"]["text"] == expected["input"]["text"]
        assert body["questions"]["next_action"]["type"] == "choice"
        assert "write_document" in body["questions"]["next_action"]["criteria"]
        assert "DONE" not in body["questions"]["next_action"]["criteria"]
        return httpx.Response(200, json={"model": "jev-fixture", "answers": {"next_action": {"type": "choice", "choice": "write_document", "confidence": .95}}})
    response = asyncio.run(choose(DecisionRequest.model_validate(expected), "server-only-key", "jev-latest", httpx.MockTransport(upstream)))
    assert response.candidateId == "write_document"
    assert response.provider == "jev"
    assert response.snapshotId == "s1"

@pytest.mark.parametrize("answer", [
    {"choice": "unknown", "confidence": 1},
    {"choice": "write_document", "confidence": "1"},
    {"choice": "write_document", "confidence": True},
    {"choice": "write_document", "confidence": 2},
])
def test_malformed_decisions_fail_closed(answer):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={"answers": {"next_action": answer}}))
    with pytest.raises(DecisionError, match="invalid decision"):
        asyncio.run(choose(DecisionRequest.model_validate(request_data()), "key", "jev-latest", transport))

def test_stale_candidate_is_not_sent_upstream():
    data = request_data(); data["candidates"][0]["targetRef"] = "@stale:e1"
    transport = httpx.MockTransport(lambda _: pytest.fail("Should not call provider"))
    with pytest.raises(DecisionError, match="snapshot"):
        asyncio.run(choose(DecisionRequest.model_validate(data), "key", "jev-latest", transport))

def test_provider_error_is_sanitized():
    transport = httpx.MockTransport(lambda _: httpx.Response(500, text="SECRET_UPSTREAM_DETAILS"))
    with pytest.raises(DecisionError) as error:
        asyncio.run(choose(DecisionRequest.model_validate(request_data()), "key", "jev-latest", transport))
    assert "SECRET_UPSTREAM_DETAILS" not in str(error.value)

def test_unexpected_fields_rejected(client):
    data = request_data(); data["command"] = "shell command"
    assert client.post("/navigation/decide", json=data, headers={"Authorization": "Bearer test-app-token"}).status_code == 422

from app.schemas import DesktopDecisionRequest
from app.jev import build_payload

def desktop_request():
    return DesktopDecisionRequest.model_validate({
        'mode': 'desktop', 'taskId': '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe', 'step': 1, 'snapshotId': 'observation-1',
        'goal': 'Calculate 7 + 5 in Calculator.', 'overallGoal': 'Calculate 7 + 5 in Calculator.', 'phase': {'index': 0, 'count': 1}, 'tree': {'view': 'tree', 'path': [{'id': 'root', 'name': 'Calculator'}], 'children': 1, 'canGoUp': False}, 'context': {'app': 'Calculator', 'windowId': 'w1'},
        'inputs': [], 'observations': [{'id': 's1', 'app': 'Calculator', 'windowId': 'w1', 'title': 'Calculator', 'surface': 'window', 'complete': True, 'text': ['result: 12']}],
        'candidates': [{'id': 'action_0', 'operation': 'CLICK', 'name': 'Equals', 'description': 'Click Equals', 'app': 'Calculator', 'snapshotId': 's1', 'targetRef': '@s1:e1'}],
        'history': [], 'notices': [], 'page': {'index': 0, 'count': 2, 'totalChoices': 100, 'seen': [0]}
    })

def test_desktop_payload_has_paging_stop_and_completion_questions():
    body = build_payload(desktop_request(), 'jev-latest')
    choices = body['questions']['next_action']['criteria']
    assert {'DONE', 'STOP', 'NEXT_PAGE', 'action_0'} <= choices.keys()
    assert 'PREVIOUS_PAGE' not in choices
    assert set(body['questions']) == {'next_action', 'goal_complete'}
    assert body['questions']['goal_complete']['type'] == 'noul'
    assert body['state']['observed_accessibility_trees'][0]['text'] == ['result: 12']

def test_desktop_choices_keep_observed_geometry_for_spatial_instructions():
    data = desktop_request().model_dump()
    data['candidates'][0]['bounds'] = {'x': 30, 'y': 120, 'width': 200, 'height': 40}
    body = build_payload(DesktopDecisionRequest.model_validate(data), 'fixture')
    choice = body['questions']['next_action']['criteria']['action_0']
    assert body['state']['observed_controls'][choice['control']]['bounds'] == data['candidates'][0]['bounds']
    assert 'targetRef' not in choice
    assert 'snapshotId' not in choice

def test_focus_and_paste_is_a_bound_exact_text_choice():
    data = desktop_request().model_dump()
    data['candidates'][0].update(operation='FOCUS_AND_PASTE', inputId='text_1')
    data['inputs'] = [{'id': 'text_1', 'text': 'Hi café 😊'}]
    request = DesktopDecisionRequest.model_validate(data)
    payload = build_payload(request, 'fixture')
    choice = payload['questions']['next_action']['criteria']['action_0']
    assert choice['operation'] == 'FOCUS_AND_PASTE'
    assert choice['inputId'] == 'text_1'
    assert 'replaces its entire contents' in payload['questions']['next_action']['instructions']
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={'answers': {
        'next_action': {'choice': 'action_0', 'confidence': .97},
        'goal_complete': {'type': 'noul', 'noul': .01}
    }}))
    assert asyncio.run(choose(request, 'secret', 'fixture', transport)).candidateId == 'action_0'

def test_desktop_live_contract_batches_action_and_completion():
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={'model': 'fixture', 'answers': {
        'next_action': {'choice': 'DONE', 'confidence': .97},
        'goal_complete': {'type': 'noul', 'noul': .97}
    }}))
    result = asyncio.run(choose(desktop_request(), 'secret', 'jev-latest', transport))
    assert result.goalStatus == 'completed'
    assert result.goalConfidence == .97

def test_contradictory_completion_is_returned_for_controller_reconciliation():
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={'answers': {
        'next_action': {'choice': 'action_0', 'confidence': .3},
        'goal_complete': {'type': 'noul', 'noul': .9}
    }}))
    result = asyncio.run(choose(desktop_request(), 'secret', 'fixture', transport))
    assert result.candidateId == 'action_0' and result.goalStatus == 'continue'
    assert result.goalCompletionProbability == .9

def test_desktop_rejects_cross_snapshot_ref():
    request = desktop_request(); request.candidates[0].targetRef = '@other:e1'
    transport = httpx.MockTransport(lambda _: pytest.fail('No provider call allowed'))
    with pytest.raises(DecisionError, match='snapshot'):
        asyncio.run(choose(request, 'secret', 'jev-latest', transport))

def test_incomplete_tree_has_no_done_option():
    request = desktop_request(); request.observations[0].complete = False
    assert 'DONE' not in build_payload(request, 'jev-latest')['questions']['next_action']['criteria']

def test_failed_completion_requires_evidence_before_offering_done_again():
    request = desktop_request(); request.completionNeedsEvidence = True
    body = build_payload(request, 'jev-latest')
    assert 'DONE' not in body['questions']['next_action']['criteria']
    assert body['state']['completion_needs_more_evidence'] is True

@pytest.mark.parametrize('confidence', [0, .01, .55, 1])
def test_selected_action_is_returned_without_a_score_gate_or_extra_call(confidence):
    calls = []
    def upstream(req):
        body = json.loads(req.content); calls.append(body)
        assert 'next_action' in body['questions']
        return httpx.Response(200, json={'answers': {
            'next_action': {'choice': 'action_0', 'confidence': confidence},
            'goal_complete': {'type': 'noul', 'noul': .01}
        }})
    result = asyncio.run(choose(desktop_request(), 'secret', 'jev-latest', httpx.MockTransport(upstream)))
    assert result.candidateId == 'action_0' and result.confidence == confidence
    assert len(calls) == 1

@pytest.mark.parametrize('confidence', [float('nan'), float('inf'), -1, 1.1, True])
def test_malformed_scores_still_violate_the_response_contract(confidence):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, content=json.dumps({'answers': {
        'next_action': {'choice': 'action_0', 'confidence': confidence},
        'goal_complete': {'type': 'noul', 'noul': .5}
    }})))
    with pytest.raises(DecisionError, match='invalid decision'):
        asyncio.run(choose(desktop_request(), 'secret', 'fixture', transport))

@pytest.mark.parametrize('probability', [None, '0.9', True, -1, 1.1, float('nan'), float('inf')])
def test_malformed_noul_never_reaches_desktop(probability):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, content=json.dumps({'answers': {
        'next_action': {'choice': 'action_0', 'confidence': .01},
        'goal_complete': {'type': 'noul', 'noul': probability},
    }})))
    with pytest.raises(DecisionError, match='invalid decision'):
        asyncio.run(choose(desktop_request(), 'secret', 'fixture', transport))

def test_native_choices_reference_node_context_without_repeating_paths():
    request = desktop_request()
    candidate = request.candidates[0]
    candidate.nodeId = 'n0_1'
    candidate.description = 'Repeated ancestor description ' * 40
    second = candidate.model_copy(update={'id': 'focus_same_node', 'operation': 'FOCUS'})
    request.candidates.append(second)
    body = build_payload(request, 'fixture')
    controls = body['state']['observed_controls']
    assert len(controls) == 1
    assert controls['c0']['node'] == 'n0_1'
    assert 'context' not in controls['c0']
    assert 'Repeated ancestor description' not in json.dumps(body)
    choices = body['questions']['next_action']['criteria']
    assert choices[candidate.id]['control'] == choices['focus_same_node']['control']
    assert choices['focus_same_node']['operation'] == 'FOCUS'

@pytest.mark.parametrize('can_go_up,count', [(False, 253), (True, 251)])
def test_choice_limit_includes_broker_navigation_options(can_go_up, count):
    request = desktop_request()
    request.page.count = 1
    request.tree.canGoUp = can_go_up
    prototype = request.candidates[0]
    request.candidates = [prototype.model_copy(update={'id': f'action_{i}'}) for i in range(count)]
    calls = []
    def upstream(req):
        body = json.loads(req.content)
        calls.append(body)
        assert len(body['questions']['next_action']['criteria']) == 255
        return httpx.Response(200, json={'answers': {
            'next_action': {'choice': 'action_0', 'confidence': .01},
            'goal_complete': {'type': 'noul', 'noul': .01}
        }})
    transport = httpx.MockTransport(upstream)
    assert asyncio.run(choose(request, 'secret', 'fixture', transport)).candidateId == 'action_0'
    request.candidates.append(prototype.model_copy(update={'id': 'overflow'}))
    with pytest.raises(DecisionError, match='256 choices; maximum is 255'):
        asyncio.run(choose(request, 'secret', 'fixture', transport))
    assert len(calls) == 1
