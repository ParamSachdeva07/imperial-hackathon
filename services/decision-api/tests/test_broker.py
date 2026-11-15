import asyncio
import json
import httpx
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.navigator import build_state, parse_step, plan, wire_schema
from app.orchestrator import build_messages, orchestrate
from app.providers import ModelConfig, ModelError, configuration
from app.schemas import OrchestratorRequest, PlanRequest

CEREBRAS = ModelConfig('cerebras', 'cerebras-key', 'qwen-3.8-27b', 'low', None)
OPENAI = ModelConfig('openai', 'openai-key', 'gpt-6-luna', 'none', 'priority')


def plan_request(**over):
    return PlanRequest.model_validate({
        'taskId': 't1', 'observationId': 'o1', 'goal': 'Open YouTube',
        'mission': {'objective': 'Open YouTube', 'doneWhen': 'YouTube is showing', 'context': '', 'irreversible': False},
        'effects': [], 'observation': {'app': 'Google Chrome', 'complete': True, 'notices': []},
        'elements': [{'id': 'e1', 'role': 'button', 'label': 'Search', 'value': '', 'states': [], 'path': '', 'operations': ['CLICK'], 'tags': []},
                     {'id': 'e2', 'role': 'statictext', 'label': 'Home', 'value': '', 'states': [], 'path': '', 'operations': [], 'tags': []}],
        'scopes': [{'id': 'surface:window', 'label': 'Browser window'}], 'allowedKeys': ['return'], 'tools': ['OPEN_URL', 'SEARCH_WEB'],
        'query': '', 'issues': [], **over})


def step(**over):
    return json.dumps({'reconciliations': [], 'kind': 'act', 'operation': 'CLICK', 'target': 'e1', 'text': '', 'key': '', 'direction': '',
                       'risk': 'reversible', 'expect': 'results', 'query': '', 'scope': '', 'waitMs': 0, 'report': None, **over})


def decision(**over):
    return json.dumps({'next': 'continue', 'objective': 'Open YouTube', 'doneWhen': 'YouTube is showing', 'context': '',
                       'irreversible': False, 'plan': [{'text': 'Open YouTube', 'status': 'todo'}], 'message': '', **over})


def cerebras_reply(text):
    return {'choices': [{'finish_reason': 'stop', 'message': {'content': text}}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 2}}


def openai_reply(text):
    return {'status': 'completed', 'output': [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}],
            'usage': {'input_tokens': 20, 'output_tokens': 4, 'input_tokens_details': {'cached_tokens': 7}}}


def client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_only_identifiers_from_this_observation_can_be_chosen():
    schema = wire_schema(plan_request())
    assert schema['properties']['target']['enum'] == ['', 'e1']
    assert schema['properties']['scope']['enum'] == ['', 'surface:window']
    assert schema['properties']['reconciliations']['maxItems'] == 0
    pending = wire_schema(plan_request(effects=[{'id': 'fx1', 'outcome': 'unknown'}, {'id': 'fx2', 'outcome': 'confirmed'}]))
    assert pending['$defs']['Reconciliation']['properties']['effectId']['enum'] == ['fx1']


def test_the_navigator_reads_the_session_objective_and_the_user_goal_separately():
    state = build_state(plan_request(goal='Find a video', issues=[]))
    assert state['objective'] == 'Open YouTube' and state['user_goal'] == 'Find a video'
    assert state['tools'] == ['OPEN_URL', 'SEARCH_WEB'] and 'issues' not in state


@pytest.mark.parametrize('text', [step(target='e9'), step(kind='read', operation='', target='', scope='region:e1'), step(kind='yield', operation='', target='')])
def test_a_step_outside_the_observation_or_a_yield_without_a_report_is_invalid(text):
    with pytest.raises(ValueError):
        parse_step(text, plan_request(), 'm')


def test_cerebras_navigator_call_binds_the_task_and_reports_usage():
    def upstream(request):
        body = json.loads(request.content)
        assert str(request.url) == 'https://api.cerebras.ai/v1/chat/completions' and request.headers['Authorization'] == 'Bearer cerebras-key'
        assert body['model'] == 'qwen-3.8-27b' and body['reasoning_effort'] == 'low'
        assert 'maxLength' not in json.dumps(body['response_format'])
        return httpx.Response(200, json=cerebras_reply(step()))
    result = asyncio.run(plan(plan_request(), CEREBRAS, client(upstream)))
    assert (result.taskId, result.observationId, result.target, result.usage.inputTokens) == ('t1', 'o1', 'e1', 10)


@pytest.mark.parametrize('reply, retryable', [
    (httpx.Response(401, json={'error': {'code': 'invalid_api_key'}}), False),
    (httpx.Response(400, json={'error': {'code': 'invalid_prompt'}}), False),
    (httpx.Response(429, json={'error': {'code': 'rate_limit'}}), True),
    (httpx.Response(429, json={'error': {'code': 'insufficient_quota'}}), False),
    (httpx.Response(503, text='busy'), True),
    (httpx.Response(200, json=cerebras_reply('not json')), True),
    (httpx.Response(200, json={'choices': [{'finish_reason': 'length', 'message': {'content': step()}}]}), True),
])
def test_failures_say_whether_asking_again_could_help(reply, retryable):
    with pytest.raises(ModelError) as error:
        asyncio.run(plan(plan_request(), CEREBRAS, client(lambda request: reply)))
    assert error.value.retryable is retryable


def test_a_timeout_is_retryable():
    def upstream(request):
        raise httpx.ReadTimeout('slow')
    with pytest.raises(ModelError) as error:
        asyncio.run(plan(plan_request(), CEREBRAS, client(upstream)))
    assert error.value.retryable


def luna_request(history=()):
    return OrchestratorRequest.model_validate({'taskId': 't1', 'goal': 'Open YouTube', 'callerContext': 'Chrome is open', 'plan': [],
        'history': list(history), 'screen': {'app': 'Google Chrome', 'title': 'New Tab', 'address': '', 'elements': []}})


def test_luna_sees_history_as_a_stable_prefix_and_the_screen_last():
    pair = {'assignment': {'objective': 'Open YouTube'}, 'result': {'status': 'done', 'summary': 'YouTube is open', 'facts': ['heading "YouTube"']}}
    one, two = build_messages(luna_request([pair])), build_messages(luna_request([pair, pair]))
    assert two[:1] == one[:1] and len(two) == 3
    assert json.loads(two[-1])['caller_context'] == 'Chrome is open' and 'screen' in json.loads(two[-1])


def test_luna_call_uses_openai_structured_output_and_keeps_usage():
    def upstream(request):
        body = json.loads(request.content)
        assert str(request.url) == 'https://api.openai.com/v1/responses' and request.headers['Authorization'] == 'Bearer openai-key'
        assert body['reasoning'] == {'effort': 'none'} and body['service_tier'] == 'priority' and body['store'] is False
        assert body['text']['format']['strict'] is True
        return httpx.Response(200, json=openai_reply(decision()))
    result = asyncio.run(orchestrate(luna_request(), OPENAI, client(upstream)))
    assert (result.next, result.taskId, result.usage.cachedInputTokens) == ('continue', 't1', 7)


@pytest.mark.parametrize('text', [decision(objective=' '), decision(next='ask_user'), '{}'])
def test_an_unusable_decision_is_a_retryable_error_not_a_decision(text):
    with pytest.raises(ModelError) as error:
        asyncio.run(orchestrate(luna_request(), OPENAI, client(lambda request: httpx.Response(200, json=openai_reply(text)))))
    assert error.value.retryable


def test_each_role_reads_its_own_provider_and_key(monkeypatch):
    for name in ('NAVIGATOR_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORCHESTRATOR_REASONING_EFFORT', 'ORCHESTRATOR_SERVICE_TIER', 'CEREBRAS_MODEL', 'CEREBRAS_REASONING_EFFORT'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('SUPERVISOR_PROVIDER', 'cerebras')
    monkeypatch.setenv('ORCHESTRATOR_PROVIDER', 'openai')
    monkeypatch.setenv('CEREBRAS_API_KEY', 'c-key')
    monkeypatch.setenv('OPENAI_API_KEY', 'o-key')
    monkeypatch.setenv('OPENAI_MODEL', 'some-model')
    navigator, luna = configuration('navigator'), configuration('orchestrator')
    assert (navigator.provider, navigator.key, navigator.model, navigator.reasoning_effort) == ('cerebras', 'c-key', 'qwen-3.8-27b', 'low')
    assert (luna.provider, luna.key, luna.model) == ('openai', 'o-key', 'some-model')


def test_routes_need_the_application_token_and_health_never_returns_a_key(monkeypatch):
    monkeypatch.setenv('DECISION_API_TOKEN', 'app-token')
    monkeypatch.setenv('SUPERVISOR_PROVIDER', 'cerebras')
    monkeypatch.setenv('CEREBRAS_API_KEY', 'secret-fixture-key')
    api = TestClient(app)
    assert api.post('/navigation/plan', json={}).status_code == 401
    health = api.get('/health', headers={'Authorization': 'Bearer app-token'})
    assert health.json()['navigatorConfigured'] is True and 'secret-fixture-key' not in health.text
    monkeypatch.setenv('CEREBRAS_API_KEY', '')
    missing = api.post('/navigation/plan', json=plan_request().model_dump(), headers={'Authorization': 'Bearer app-token'})
    assert missing.status_code == 503 and 'CEREBRAS_API_KEY' in missing.json()['detail']
