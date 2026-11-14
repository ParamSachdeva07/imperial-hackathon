import asyncio
import copy
import json
import httpx
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.schemas import SupervisorRequest, SupervisorGuidance, DesktopDecisionRequest
from app.supervisor import build_payload, supervise, SupervisorError, evidence_catalog
from app.jev import build_desktop_payload
from test_api import desktop_request


def request_data():
    observation = desktop_request().model_dump(mode='json')
    return {
        'taskId': observation['taskId'], 'snapshotId': observation['snapshotId'],
        'step': 1, 'goal': observation['overallGoal'], 'reason': 'initial',
        'observation': observation, 'previous': None, 'issue': '',
    }


def plan_data():
    return {
        'status': 'continue', 'subgoal': 'Read the result.',
        'plan': ['Read the result.'], 'memory': ['The requested expression is 7 + 5.'],
        'inputs': [{'id': 'expression', 'text': '7 + 5'}],
        'expectedOutcome': {
            'kind': 'text_equals', 'description': 'Result reads 12.',
            'target': {'app': 'Calculator', 'windowTitle': 'Calculator', 'role': '', 'name': ''},
            'value': '12', 'checks': [],
        },
        'evidence': ['result: 12'], 'rationale': 'A current result is exposed.',
    }


def response_data(plan=None):
    plan = copy.deepcopy(plan if plan is not None else plan_data())
    plan.pop('plan', None)
    plan.pop('rationale', None)
    plan['expectedOutcome'].pop('description', None)
    # The wire format selects catalog IDs; the local contract contains tuples.
    plan['expectedOutcome']['target'] = 'unbound'
    for check in plan['expectedOutcome']['checks']:
        check['target'] = 't0'
    catalog = evidence_catalog(SupervisorRequest.model_validate(request_data()))
    for i, value in enumerate(plan['evidence']):
        plan['evidence'][i] = next((key for key, item in catalog.items() if item['text'] == value), value)
    return {
        'status': 'completed',
        'output': [{'type': 'message', 'content': [
            {'type': 'output_text', 'text': json.dumps(plan)},
        ]}],
    }


def call_provider(response, data=None):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=response))
    return asyncio.run(supervise(
        SupervisorRequest.model_validate(data or request_data()), 'server-only-key', 'fixture-model', transport,
    ))


def test_responses_api_uses_strict_schema_without_desktop_tools_and_binds_ids():
    data = request_data()
    def upstream(request):
        assert str(request.url) == 'https://api.openai.com/v1/responses'
        assert request.headers['Authorization'] == 'Bearer server-only-key'
        body = json.loads(request.content)
        assert body['store'] is False
        assert body['model'] == 'configured-model'
        assert 'tools' not in body
        schema = body['text']['format']
        assert schema['type'] == 'json_schema' and schema['strict'] is True
        assert schema['schema']['additionalProperties'] is False
        assert set(schema['schema']['required']) == set(plan_data()) - {'plan', 'rationale'}
        state = json.loads(body['input'][0]['content'])
        assert state['original_user_goal'] == data['goal']
        assert state['current_observation']['observations'][0]['text'] == ['result: 12']
        assert 'first item' in body['instructions']
        assert 'NEVER request repeating' in body['instructions']
        return httpx.Response(200, json=response_data())
    result = asyncio.run(supervise(SupervisorRequest.model_validate(data), 'server-only-key', 'configured-model', httpx.MockTransport(upstream)))
    assert result.taskId == data['taskId'] and result.snapshotId == data['snapshotId']
    assert result.inputs[0].text == '7 + 5'


def test_previous_context_persists_without_recursive_guidance():
    data = request_data()
    previous = {**plan_data(), 'taskId': data['taskId'], 'snapshotId': 'earlier-observation'}
    data['previous'] = previous
    data['observation']['supervisor'] = previous
    data['reason'] = 'uncertain_action'
    data['issue'] = 'Delivery unknown; do not replay.'
    state = json.loads(build_payload(SupervisorRequest.model_validate(data), 'fixture')['input'][0]['content'])
    assert state['previous_guidance'] == previous
    assert 'supervisor' not in state['current_observation']
    assert state['controller_issue'] == data['issue']


def test_explicit_latency_settings_and_shared_client_are_used_without_changing_the_contract():
    async def run():
        def upstream(request):
            body = json.loads(request.content)
            assert body['reasoning'] == {'effort': 'low'}
            assert body['service_tier'] == 'ultrafast'
            assert body['text']['format']['strict'] is True
            return httpx.Response(200, json=response_data())
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            result = await supervise(SupervisorRequest.model_validate(request_data()), 'fixture-key', 'configured-model',
                client=client, reasoning_effort='low', service_tier='ultrafast')
            assert not client.is_closed
            assert result.status == 'continue'
    asyncio.run(run())


def test_latency_settings_are_optional_for_other_compatible_models():
    body = build_payload(SupervisorRequest.model_validate(request_data()), 'fixture-model')
    assert 'reasoning' not in body and 'service_tier' not in body


@pytest.mark.parametrize('field,value', [
    ('snapshotId', 'stale-observation'),
    ('taskId', 'aba54f61-a2c8-4e55-b80c-c1e3e094f5fe'),
    ('goal', 'A different task'),
])
def test_mismatched_request_is_not_sent_to_provider(field, value):
    data = request_data(); data[field] = value
    transport = httpx.MockTransport(lambda _: pytest.fail('Must not send mismatched context'))
    with pytest.raises(SupervisorError, match='does not match'):
        asyncio.run(supervise(SupervisorRequest.model_validate(data), 'key', 'fixture', transport))


def test_memory_cannot_cross_tasks():
    data = request_data()
    data['previous'] = {**plan_data(), 'taskId': 'a-different-task', 'snapshotId': 'previous'}
    with pytest.raises(SupervisorError, match='different task'):
        build_payload(SupervisorRequest.model_validate(data), 'fixture')


def test_duplicate_input_ids_rejected():
    plan = plan_data(); plan['inputs'] *= 2
    with pytest.raises(SupervisorError, match='duplicate input IDs'):
        call_provider(response_data(plan))


@pytest.mark.parametrize('evidence', [[], ['The task is complete'], ['historical result: 12'], [' ']])
def test_completion_requires_current_observed_excerpts(evidence):
    plan = plan_data(); plan.update(status='completed', evidence=evidence)
    with pytest.raises(SupervisorError, match='evidence'):
        call_provider(response_data(plan))


def test_valid_completion_is_not_a_confidence_vote():
    plan = plan_data(); plan['status'] = 'completed'
    result = call_provider(response_data(plan))
    assert result.status == 'completed'
    assert 'confidence' not in result.model_dump()


def test_incomplete_observation_cannot_claim_completion():
    data = request_data(); data['observation']['observations'][0]['complete'] = False
    plan = plan_data(); plan['status'] = 'completed'
    with pytest.raises(SupervisorError, match='current observable evidence'):
        call_provider(response_data(plan), data)


@pytest.mark.parametrize('response,match', [
    ({'status': 'incomplete', 'output': []}, 'incomplete'),
    ({'status': 'completed', 'output': []}, 'unambiguous'),
    ({'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'refusal', 'refusal': 'no'}]}]}, 'could not provide'),
    ({'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '{}'}]}]}, 'invalid plan'),
])
def test_unusable_response_never_becomes_guidance(response, match):
    with pytest.raises(SupervisorError, match=match):
        call_provider(response)


def test_unexpected_executable_fields_are_rejected():
    plan = plan_data(); plan['shellCommand'] = 'do something'
    with pytest.raises(SupervisorError, match='invalid plan'):
        call_provider(response_data(plan))


@pytest.mark.parametrize('status,match', [(401, 'key or model access'), (403, 'key or model access'), (429, 'quota'), (500, 'request failed')])
def test_provider_errors_are_sanitized(status, match):
    transport = httpx.MockTransport(lambda _: httpx.Response(status, text='PRIVATE_PROVIDER_ERROR'))
    with pytest.raises(SupervisorError, match=match) as error:
        asyncio.run(supervise(SupervisorRequest.model_validate(request_data()), 'key', 'fixture', transport))
    assert 'PRIVATE_PROVIDER_ERROR' not in str(error.value)


def test_authenticated_route_and_explicit_missing_key(monkeypatch):
    monkeypatch.setenv('SUPERVISOR_PROVIDER', 'openai')
    monkeypatch.setenv('DECISION_API_TOKEN', 'test-app-token')
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    client = TestClient(app)
    assert client.post('/navigation/supervise', json=request_data()).status_code == 401
    response = client.post('/navigation/supervise', json=request_data(), headers={'Authorization': 'Bearer test-app-token'})
    assert response.status_code == 503
    assert 'OPENAI_API_KEY' in response.json()['detail']


def test_health_reports_config_without_keys(monkeypatch):
    monkeypatch.setenv('SUPERVISOR_PROVIDER', 'openai')
    monkeypatch.setenv('DECISION_API_TOKEN', 'test-app-token')
    monkeypatch.setenv('OPENAI_API_KEY', 'never-return-this-secret')
    monkeypatch.setenv('OPENAI_MODEL', 'configured-model')
    response = TestClient(app).get('/health', headers={'Authorization': 'Bearer test-app-token'})
    assert response.json()['supervisorConfigured'] is True
    assert response.json()['supervisorModel'] == 'configured-model'
    assert 'never-return-this-secret' not in response.text


def test_route_omits_unavailable_identity_fields_instead_of_returning_null(monkeypatch):
    monkeypatch.setenv('SUPERVISOR_PROVIDER', 'openai')
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture')
    monkeypatch.setenv('DECISION_API_TOKEN', 'test-app-token')
    async def fixture(request, *args, **kwargs):
        return SupervisorGuidance.model_validate({**plan_data(), 'taskId': str(request.taskId), 'snapshotId': request.snapshotId})
    monkeypatch.setattr('app.main.supervise', fixture)
    response = TestClient(app).post('/navigation/supervise', json=request_data(),
        headers={'Authorization': 'Bearer test-app-token'})
    assert response.status_code == 200
    target = response.json()['expectedOutcome']['target']
    assert target == plan_data()['expectedOutcome']['target']


def test_jev_receives_semantic_guidance_and_expanded_budget():
    data = request_data(); observation = data['observation']; observation['step'] = 500
    guidance = {**plan_data(), 'taskId': data['taskId'], 'snapshotId': data['snapshotId']}
    observation['supervisor'] = guidance
    payload = build_desktop_payload(DesktopDecisionRequest.model_validate(observation), 'fixture')
    assert payload['state']['supervisor_guidance'] == {key: guidance[key] for key in ('subgoal', 'memory', 'expectedOutcome')}
    instructions = payload['questions']['next_action']['instructions']
    assert 'splits an explicit then-sequence' not in instructions
    assert 'first/top/current' in instructions
    assert 'minimum requirements' in instructions


def test_initial_application_inventory_can_be_cited_without_a_window_tree():
    data = request_data()
    data['observation']['observations'] = []
    data['observation']['candidates'] = [{
        'id': 'open', 'operation': 'OPEN_APP', 'description': 'Launch app',
        'name': 'Editor', 'app': 'editor',
    }]
    catalog = evidence_catalog(SupervisorRequest.model_validate(data))
    assert catalog == {'e0': {'kind': 'application', 'text': 'Application available: Editor'}}
    plan = plan_data(); plan['evidence'] = ['e0']
    result = call_provider(response_data(plan), data)
    assert result.evidence == ['Application available: Editor']
    plan['status'] = 'completed'
    with pytest.raises(SupervisorError, match='current observable evidence'):
        call_provider(response_data(plan), data)


def test_evidence_output_is_constrained_to_current_ids():
    request = SupervisorRequest.model_validate(request_data())
    schema = build_payload(request, 'fixture')['text']['format']['schema']
    assert schema['properties']['evidence']['items']['enum'] == list(evidence_catalog(request))
    plan = plan_data(); plan['evidence'] = ['e999']
    with pytest.raises(SupervisorError, match='evidence reference'):
        call_provider(response_data(plan))


def test_outcome_target_uses_current_catalog_identity_not_model_spelling():
    data = request_data()
    data['observation']['observedTargets'] = [{'app': 'Editor', 'windowTitle': 'Document',
        'windowId': 'w1', 'nativeId': 'size', 'nativeIdKind': 'identifier', 'path': 'Toolbar > Text',
        'role': 'combobox', 'name': 'Size:', 'value': '24', 'states': ['focused']}]
    request = SupervisorRequest.model_validate(data)
    schema = build_payload(request, 'fixture')['text']['format']['schema']
    assert schema['$defs']['SupervisorTarget'] == {'type': 'string', 'enum': ['unbound', 't0']}
    response = response_data()
    wire = json.loads(response['output'][0]['content'][0]['text'])
    wire['expectedOutcome']['target'] = 't0'
    response['output'][0]['content'][0]['text'] = json.dumps(wire)
    bound = call_provider(response, data).expectedOutcome.target
    assert bound.name == 'Size:'
    assert (bound.windowId, bound.nativeId, bound.nativeIdKind, bound.path) == ('w1', 'size', 'identifier', 'Toolbar > Text')
    wire['expectedOutcome']['target'] = 't999'
    response['output'][0]['content'][0]['text'] = json.dumps(wire)
    with pytest.raises(SupervisorError, match='outcome target'):
        call_provider(response, data)
