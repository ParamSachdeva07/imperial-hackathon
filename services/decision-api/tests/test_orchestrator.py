import asyncio
import json
import httpx
import pytest
from app.planner import PlannerError
from app.orchestrator import orchestrate, build_input
from app.schemas import OrchestratorRequest, SemanticRecord, MilestoneReview
from pydantic import ValidationError
from app.usage import model_usage


def request():
    return OrchestratorRequest.model_validate({
        'taskId': '9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe', 'goal': 'Apply 24 pt',
        'answers': [], 'requirements': [], 'effects': [], 'sessions': [], 'stepsLeft': None,
        'screen': {'app': 'Editor', 'title': 'Draft', 'notices': [], 'elements': [],
                   'scopes': [{'id': 'surface:window', 'label': 'Read native window'}]},
    })


def test_orchestrator_uses_structured_navigation_and_preserves_usage():
    async def run():
        def respond(req):
            payload = json.loads(req.content)
            assert payload['response_format']['json_schema']['strict'] is True
            assert 'surface:window' in payload['messages'][1]['content']
            body = {'kind': 'navigate', 'doneWhen': 'The relevant controls are observed', 'inputs': [], 'allowRepetition': False, 'objective': 'Inspect native controls',
                    'context': 'The page did not expose the editor. Read the native window.', 'message': '', 'plan': [], 'milestoneId': 'inspect', 'branches': [], 'reviews': []}
            return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(body)}}],
                'usage': {'prompt_tokens': 1200, 'completion_tokens': 110, 'prompt_tokens_details': {'cached_tokens': 500}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result = await orchestrate(request(), 'test', 'fixture', client=client)
        assert result.taskId == str(request().taskId)
        assert result.usage.inputTokens == 1200
        assert result.usage.outputTokens == 110
        assert result.usage.cachedInputTokens == 500
    asyncio.run(run())


def test_invalid_milestone_choice_is_left_for_coordinator_correction():
    async def run():
        body = {'kind': 'navigate', 'doneWhen': 'The relevant controls are observed', 'inputs': [], 'allowRepetition': False, 'objective': '', 'context': '', 'message': '', 'plan': [], 'milestoneId': 'inspect', 'branches': [], 'reviews': []}
        response = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(body)}}]}
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response))) as client:
            result = await orchestrate(request(), 'test', 'fixture', client=client)
        assert result.objective == ''
        assert result.milestoneId == 'inspect'
    asyncio.run(run())


def test_missing_usage_is_unknown_not_free():
    assert model_usage({}, 'cerebras') is None
    assert model_usage({'usage': {'input_tokens': 540}}, 'typesafe').outputTokens == 0


def test_semantic_history_is_a_stable_prefix_and_screens_are_not_accumulated():
    req = request()
    req.history = [SemanticRecord(taskId=str(req.taskId), kind='assignment', summary='Enter the selected value',
                                  inputs=[{'name': 'text', 'value': 'chosen value'}], facts=[])]
    first = build_input(req)
    req.history.append(SemanticRecord(taskId=str(req.taskId), kind='result', summary='Input entered', inputs=[], facts=['Value read back']))
    req.screen.title = 'Changed screen'
    second = build_input(req)
    assert first[:-1] == second[:len(first)-1]
    assert 'Changed screen' in second[-1]['content']
    assert all('current_state' not in item['content'] for item in second[:-1])


def test_review_evidence_cannot_contain_explanatory_prose():
    review = {'milestoneId': 'g', 'status': 'evidenced', 'reason': 'Observed result', 'evidence': ['e4']}
    assert MilestoneReview.model_validate(review).evidence == ['e4']
    with pytest.raises(ValidationError):
        MilestoneReview.model_validate({**review, 'evidence': ['e4: The result is visible']})


@pytest.mark.parametrize('status,payload,expected,retryable', [
    (200, {'status': 'incomplete', 'incomplete_details': {'reason': 'max_output_tokens'}}, 'incomplete (max_output_tokens)', True),
    (429, {'error': {'code': 'rate_limit_exceeded'}}, 'HTTP 429', True),
    (429, {'error': {'code': 'insufficient_quota'}}, 'HTTP 429', False),
    (400, {'error': {'code': 'invalid_request_error'}}, 'HTTP 400', False),
])
def test_provider_failure_reports_the_actual_failure_class(status, payload, expected, retryable):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(status, json=payload))) as client:
            with pytest.raises(PlannerError, match=expected.replace('(', r'\(').replace(')', r'\)')) as error:
                await orchestrate(request(), 'test', 'fixture', provider='openai', client=client)
            assert error.value.retryable is retryable
    asyncio.run(run())


def test_selected_milestone_supplies_objective_without_repeating_it():
    async def run():
        body = {'kind': 'navigate', 'doneWhen': 'The relevant controls are observed', 'inputs': [], 'allowRepetition': False, 'objective': '', 'context': '', 'message': '',
                'plan': [{'id': 'inspect', 'text': 'Inspect the current setting', 'doneWhen': 'The applied value is read',
                          'condition': '', 'dependsOn': [], 'kind': 'outcome', 'irreversible': False}],
                'milestoneId': 'inspect', 'branches': [], 'reviews': []}
        response = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(body)}}]}
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response))) as client:
            result = await orchestrate(request(), 'test', 'fixture', client=client)
        assert result.objective == 'Inspect the current setting'
    asyncio.run(run())
