import asyncio
import copy
import json
import httpx
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.schemas import PlanRequest, GroundRequest
from app.planner import build_payload, build_state, plan, PlannerError, wire_schema
from app.grounding import ground, build_payload as ground_payload
from app.supervisor_providers import prepare_request
from app.typesafe import DecisionError

TASK = '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe'


def element(identifier, label, operations, role='button', value=''):
    return {'id': identifier, 'role': role, 'label': label, 'value': value, 'states': [], 'path': 'Document > Formatting',
            'operations': operations, 'tags': ['match']}


def request_data():
    return {
        'taskId': TASK, 'observationId': 'o1', 'step': 2, 'goal': 'Make the text 24 pt', 'literals': [], 'answers': [],
        'requirements': [{'id': 'r1', 'text': 'The text is 24 pt', 'irreversible': False, 'kind': 'outcome', 'status': 'open', 'evidence': []}],
        'effects': [{'id': 'fx1', 'step': 1, 'requirementId': 'r1', 'operation': 'SET_VALUE', 'target': 'Font Size', 'text': '24',
                     'risk': 'reversible', 'delivery': 'delivered', 'outcome': 'unknown', 'expect': 'text becomes 24 pt',
                     'added': [], 'removed': [], 'scopeChanged': False, 'note': ''}],
        'observation': {'app': 'Example', 'windowId': 'w0', 'nativeWindowId': 'w-123', 'windowTitle': 'Document', 'surface': 'window', 'complete': True,
                        'scope': [], 'outline': ['toolbar "Formatting" (2 controls)'],
                        'windows': [{'id': 'w1', 'title': 'Document', 'focused': True}], 'notices': [],
                        'capability': {'nodes': 4, 'actionable': 2, 'unlabeledActionable': 0, 'unreadRegions': 0, 'textFields': 1,
                                       'readableTextFields': 1, 'focusedElement': True, 'attributedText': 'not_exposed'}},
        'elements': [element('e1', 'Apply', ['CLICK']), element('e2', 'Applied size', [], 'statictext', '12 pt')],
        'scopes': [{'id': 'surface:menubar', 'label': 'Read the menubar surface of Example.'}],
        'allowedKeys': ['return'], 'query': 'apply', 'phase': 'planning',
        'budgets': {'stepsLeft': 10, 'verificationReadsLeft': None}, 'issues': [],
    }


def wire(**over):
    return {'requirements': [{'id': 'r1', 'text': 'The text is 24 pt', 'irreversible': False, 'kind': 'outcome'}], 'reconciliations': [], 'statuses': [],
            'kind': 'act', 'requirementId': 'r1', 'operation': 'CLICK', 'target': 'e1', 'targetDescription': 'the Apply button',
            'text': '', 'textIsLiteral': False, 'key': '', 'direction': '', 'risk': 'reversible', 'repeat': False,
            'expect': 'Applied size reads 24 pt', 'query': '', 'scope': '', 'waitMs': 0, 'message': '', 'report': None, **over}


def openai_response(data):
    return {'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(data)}]}]}


def call(response, status=200, provider='openai'):
    transport = httpx.MockTransport(lambda _: httpx.Response(status, json=response))
    return asyncio.run(plan(PlanRequest.model_validate(request_data()), 'server-only-key', 'fixture-model', transport, provider=provider))


def test_schema_only_offers_identifiers_from_this_observation():
    schema = wire_schema(PlanRequest.model_validate(request_data()))
    # Only actionable elements can be targets; a label that is not actionable can still be cited.
    assert schema['properties']['target']['enum'] == ['', 'e1']
    assert schema['properties']['scope']['enum'] == ['', 'surface:menubar']
    assert schema['$defs']['PlanReconciliation']['properties']['effectId']['enum'] == ['fx1']
    assert schema['$defs']['NavigationReport']['properties']['evidence']['items']['enum'] == ['e1', 'e2']
    assert schema['$defs']['PlanReconciliation']['properties']['evidence']['items']['enum'] == ['e1', 'e2']
    assert schema['additionalProperties'] is False and set(schema['required']) == set(schema['properties'])


def test_no_reconciliation_is_possible_without_an_unresolved_effect():
    data = request_data()
    data['effects'][0]['outcome'] = 'confirmed'
    assert wire_schema(PlanRequest.model_validate(data))['properties']['reconciliations']['maxItems'] == 0


def test_navigator_sees_the_current_subgoal_and_preserves_root_authorization():
    data = request_data()
    data['mission'] = {'objective': 'Commit and inspect the entered font size',
                       'context': 'The value is already entered; do not type it again.'}
    state = build_state(PlanRequest.model_validate(data))
    assert state['goal'] == data['mission']['objective']
    assert state['authorization_goal'] == data['goal']
    assert state['effects'][0]['id'] == 'fx1'
    assert 'budgets' not in state
    assert 'stepLimit' not in state['mission']


def test_assigned_milestone_is_not_an_executor_choice():
    data = request_data()
    data['mission'] = {'objective': 'Apply the setting', 'context': '', 'doneWhen': '24 pt is applied',
                       'milestone': {'id': 'format', 'text': 'Apply 24 pt', 'doneWhen': 'The applied value is 24 pt',
                                     'dependsOn': [], 'condition': '', 'kind': 'outcome', 'irreversible': False}}
    schema = wire_schema(PlanRequest.model_validate(data))
    assert schema['properties']['requirementId']['enum'] == ['format']
    assert schema['$defs']['PlanStatus']['properties']['requirementId']['enum'] == ['format']


def test_payload_carries_the_goal_and_drops_padding():
    body = build_payload(PlanRequest.model_validate(request_data()), 'fixture-model', reasoning_effort='low')
    state = json.loads(body['input'][0]['content'])
    assert state['goal'] == 'Make the text 24 pt' and state['active_query'] == 'apply'
    assert 'nativeWindowId' not in state['observation'] and 'w-123' not in body['input'][0]['content']
    assert 'value' not in state['elements'][0] and state['elements'][1]['value'] == '12 pt'
    assert body['reasoning'] == {'effort': 'low'} and body['store'] is False
    assert 'UNTRUSTED' not in body['instructions'] and 'untrusted data' in body['instructions']


def test_cerebras_request_uses_the_same_schema_without_unsupported_constraints():
    body = build_payload(PlanRequest.model_validate(request_data()), 'fixture-model')
    endpoint, prepared = prepare_request(body, 'cerebras')
    assert endpoint.endswith('/chat/completions')
    text = json.dumps(prepared['response_format'])
    assert prepared['response_format']['json_schema']['name'] == 'desktop_plan_step'
    assert 'maxLength' not in text and 'maxItems' not in text


def test_plan_binds_task_and_observation_on_the_server():
    step = call(openai_response(wire()))
    assert (step.taskId, step.observationId, step.kind, step.target) == (TASK, 'o1', 'act', 'e1')


@pytest.mark.parametrize('over, message', [
    ({'target': 'e2'}, 'target outside the current observation'),
    ({'target': 'e99'}, 'target outside the current observation'),
    ({'kind': 'read', 'target': '', 'scope': 'window:w9'}, 'scope outside the current observation'),
])
def test_plan_rejects_identifiers_the_model_was_not_given(over, message):
    with pytest.raises(PlannerError, match=message):
        call(openai_response(wire(**over)))


def test_plan_rejects_malformed_output_as_retryable():
    broken = wire()
    broken.pop('expect')
    with pytest.raises(PlannerError) as error:
        call(openai_response(broken))
    assert error.value.retryable is True
    with pytest.raises(PlannerError, match='no unambiguous step'):
        call({'status': 'completed', 'output': []})


def test_key_rejection_is_not_retryable_but_rate_limit_is():
    with pytest.raises(PlannerError) as denied:
        call({}, status=401)
    assert denied.value.retryable is False
    with pytest.raises(PlannerError) as limited:
        call({}, status=429)
    assert limited.value.retryable is True


def test_cerebras_response_shape_is_normalised():
    response = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(wire())}}]}
    assert call(response, provider='cerebras').operation == 'CLICK'


def ground_request(**over):
    return GroundRequest.model_validate({'taskId': TASK, 'observationId': 'o1', 'goal': 'Make the text 24 pt',
        'requirement': 'The text is 24 pt', 'operation': 'CLICK', 'text': '', 'key': '', 'targetDescription': 'the Apply button',
        'elements': [element('e1', 'Apply', ['CLICK']), element('e3', 'Send', ['CLICK'])], **over})


def ground_call(answer, request=None):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={'model': 'jev-test', 'answers': {'target': answer}}))
    return asyncio.run(ground(request or ground_request(), 'server-only-key', 'jev-latest', transport))


def test_grounding_chooses_among_supplied_elements_only():
    criteria = ground_payload(ground_request(), 'jev-latest')['questions']['target']['criteria']
    assert set(criteria) == {'e1', 'e3', 'NONE'}
    assert ground_call({'choice': 'e1', 'confidence': 0.8}).target == 'e1'
    assert ground_call({'choice': 'NONE', 'confidence': 0.6}).target == ''
    with pytest.raises(DecisionError, match='invalid grounding answer'):
        ground_call({'choice': 'e9', 'confidence': 0.8})


def test_grounding_cannot_widen_the_operation():
    request = ground_request(elements=[element('e1', 'Apply', ['CLICK']), element('e2', 'Applied size', [], 'statictext')])
    with pytest.raises(DecisionError, match='must support the operation') as error:
        ground_call({'choice': 'e1', 'confidence': 0.8}, request)
    assert error.value.retryable is False


def test_routes_require_the_application_token_and_mark_retryable_failures(monkeypatch):
    monkeypatch.setenv('DECISION_API_TOKEN', 'app-token')
    monkeypatch.setenv('SUPERVISOR_PROVIDER', 'openai')
    monkeypatch.setenv('OPENAI_API_KEY', 'server-only-key')
    monkeypatch.setenv('TYPESAFE_API_KEY', 'server-only-key')
    client = TestClient(app)
    assert client.post('/navigation/plan', json=request_data()).status_code == 401
    headers = {'Authorization': 'Bearer app-token'}

    async def limited(*_args, **_kwargs):
        raise PlannerError('OpenAI planner rate limit or quota reached. No desktop action was sent.')
    async def denied(*_args, **_kwargs):
        raise DecisionError('TypeSafe rejected the API key. Check the backend environment file.', retryable=False)
    monkeypatch.setattr('app.main.plan', limited)
    monkeypatch.setattr('app.main.ground', denied)
    response = client.post('/navigation/plan', json=request_data(), headers=headers)
    assert (response.status_code, response.headers['x-retryable']) == (502, '1')
    grounded = client.post('/navigation/ground', json=ground_request().model_dump(mode='json'), headers=headers)
    assert (grounded.status_code, grounded.headers['x-retryable']) == (502, '0')
    extra = copy.deepcopy(request_data())
    extra['unexpected'] = True
    assert client.post('/navigation/plan', json=extra, headers=headers).status_code == 422
