import asyncio
import json
import httpx
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.schemas import SupervisorRequest
from app.supervisor import supervise, SupervisorError
from app.supervisor_providers import configuration, structured_text
from test_supervisor import request_data, response_data


def completion_response():
    return {'choices': [{'finish_reason': 'stop', 'message': {
        'content': response_data()['output'][0]['content'][0]['text'],
    }}]}


def test_cerebras_wire_contract_disables_thinking_and_preserves_plan_validation():
    calls = []
    def upstream(request):
        calls.append(request)
        assert str(request.url) == 'https://api.cerebras.ai/v1/chat/completions'
        assert request.headers['authorization'] == 'Bearer cerebras-only-secret'
        body = json.loads(request.content)
        assert body['reasoning_effort'] == 'none'
        assert body['model'] == 'qwen-3.8-27b'
        assert not {'store', 'service_tier', 'input', 'text', 'tools'} & body.keys()
        assert body['messages'][0]['role'] == 'system'
        schema = body['response_format']['json_schema']
        assert schema['strict'] is True
        assert schema['schema']['properties']['evidence']['items']['enum']
        wire = json.dumps(schema)
        for keyword in ('minItems', 'maxItems', 'minLength', 'maxLength', 'format', 'pattern'):
            assert '"' + keyword + '":' not in wire
        return httpx.Response(200, json=completion_response())
    result = asyncio.run(supervise(SupervisorRequest.model_validate(request_data()),
        'cerebras-only-secret', 'qwen-3.8-27b', httpx.MockTransport(upstream), provider='cerebras', service_tier='ultrafast'))
    assert result.inputs[0].text == '7 + 5'
    assert len(calls) == 1


@pytest.mark.parametrize('kind', ['truncated', 'refusal', 'bad_evidence', 'bad_plan', 'multiple'])
def test_cerebras_unusable_output_is_not_guidance(kind):
    response = completion_response()
    choice = response['choices'][0]
    if kind == 'truncated': choice['finish_reason'] = 'length'
    if kind == 'refusal': choice['message']['refusal'] = 'no'
    if kind in {'bad_evidence', 'bad_plan'}:
        plan = json.loads(choice['message']['content'])
        if kind == 'bad_evidence': plan['evidence'] = ['invented-evidence']
        else: plan['plan'] = ['x'] * 100
        choice['message']['content'] = json.dumps(plan)
    if kind == 'multiple': response['choices'] *= 2
    with pytest.raises(SupervisorError):
        asyncio.run(supervise(SupervisorRequest.model_validate(request_data()), 'key', 'fixture',
            httpx.MockTransport(lambda _: httpx.Response(200, json=response)), provider='cerebras'))


def test_provider_key_isolation_and_health(monkeypatch):
    monkeypatch.setenv('CEREBRAS_REASONING_EFFORT', 'none')
    monkeypatch.setenv('SUPERVISOR_PROVIDER', 'cerebras')
    monkeypatch.setenv('OPENAI_API_KEY', 'openai-secret')
    monkeypatch.delenv('CEREBRAS_API_KEY', raising=False)
    assert configuration().key == ''  # Never fall back to another provider's key.
    monkeypatch.setenv('CEREBRAS_API_KEY', 'cerebras-secret')
    monkeypatch.setenv('DECISION_API_TOKEN', 'token')
    response = TestClient(app).get('/health', headers={'Authorization': 'Bearer token'})
    assert response.json()['supervisorConfigured'] is True
    assert response.json()['supervisorProvider'] == 'cerebras'
    assert response.json()['supervisorReasoningEffort'] == 'none'
    assert 'secret' not in response.text


def test_orchestrator_provider_is_independent_of_navigator(monkeypatch):
    monkeypatch.setenv('SUPERVISOR_PROVIDER', 'cerebras')
    monkeypatch.setenv('CEREBRAS_API_KEY', 'navigator-key')
    monkeypatch.setenv('CEREBRAS_MODEL', 'gpt-oss-120b')
    monkeypatch.setenv('ORCHESTRATOR_PROVIDER', 'openai')
    monkeypatch.setenv('ORCHESTRATOR_MODEL', 'gpt-6-luna')
    monkeypatch.setenv('ORCHESTRATOR_REASONING_EFFORT', 'none')
    monkeypatch.setenv('OPENAI_SERVICE_TIER', 'ultrafast')
    monkeypatch.setenv('ORCHESTRATOR_SERVICE_TIER', '')
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    assert configuration('orchestrator').key == ''
    monkeypatch.setenv('OPENAI_API_KEY', 'orchestrator-key')
    coordinator = configuration('orchestrator')
    assert (coordinator.provider, coordinator.key, coordinator.model) == ('openai', 'orchestrator-key', 'gpt-6-luna')
    assert coordinator.reasoning_effort == 'none'
    assert coordinator.service_tier is None
    assert (configuration().provider, configuration().key, configuration().model) == ('cerebras', 'navigator-key', 'gpt-oss-120b')


def test_response_phases_do_not_turn_commentary_into_an_action_plan():
    commentary = {'type': 'message', 'phase': 'commentary', 'content': [{'type': 'output_text', 'text': 'Not a plan {broken}'}]}
    final = {'type': 'message', 'phase': 'final_answer', 'status': 'completed',
             'content': [{'type': 'output_text', 'text': '{"kind":'}, {'type': 'output_text', 'text': '"navigate"}'}]}
    assert structured_text({'status': 'completed', 'output': [commentary, final]}) == '{"kind":"navigate"}'
    for items in [[commentary], [final, final], [{**final, 'status': 'incomplete'}],
                  [{**final, 'content': [{'type': 'refusal', 'refusal': 'No'}]}]]:
        with pytest.raises(ValueError):
            structured_text({'status': 'completed', 'output': items})
