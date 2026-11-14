import asyncio
import json
import httpx
import pytest
from app.schemas import TextResolutionRequest
from app.text_resolution import resolve_text, instruction_tokens
from app.jev import DecisionError


def request(goal='Search YouTube for 3d printer'):
    return TextResolutionRequest(taskId='9e5a4f61-a2c8-4e55-b80c-c1e3e094f5fe',snapshotId='s1',candidateId='write',goal=goal,purpose='field_text',
        target={'app':'Google Chrome','role':'textfield','name':'Search','value':'','description':'YouTube Search'},history=[])


def upstream(start='t3', end='t4', support='yes', support_confidence=.99):
    def handle(req):
        body=json.loads(req.content)
        if 'supported' in body['questions']:
            assert body['state']['proposed_text']=='3d printer'
            return httpx.Response(200,json={'answers':{'supported':{'choice':support,'confidence':support_confidence}}})
        assert body['state']['user_instruction']=='Search YouTube for 3d printer'
        assert body['questions']['start']['criteria']['t3']['token']=='3d'
        return httpx.Response(200,json={'model':'fixture','answers':{'start':{'choice':start,'confidence':.95},'end':{'choice':end,'confidence':.99}}})
    return httpx.MockTransport(handle)


def test_unquoted_text_is_source_slice_with_verified_boundaries():
    r=asyncio.run(resolve_text(request(),'key','jev',upstream()))
    assert r.status=='resolved' and r.text=='3d printer'
    assert request().goal[r.start:r.end]==r.text


@pytest.mark.parametrize('start,end,support',[('NONE','NONE','yes'),('t4','t3','yes'),('t3','t4','no')])
def test_ambiguous_reversed_or_unsupported_text_sends_no_text(start,end,support):
    r=asyncio.run(resolve_text(request(),'key','jev',upstream(start,end,support)))
    assert r.status=='unavailable' and r.text==''


def test_unrecognized_boundary_is_rejected():
    with pytest.raises(DecisionError,match='invalid text selection'):
        asyncio.run(resolve_text(request(),'key','jev',upstream('invented')))


def test_tokenization_preserves_urls_and_multilingual_text():
    goal='Open https://example.com/watch?v=3 and search for café ☕'
    tokens=instruction_tokens(goal)
    assert [t.group() for t in tokens]==['Open','https://example.com/watch?v=3','and','search','for','café','☕']


def test_provider_error_does_not_leak_response():
    transport=httpx.MockTransport(lambda _: httpx.Response(500,text='SECRET'))
    with pytest.raises(DecisionError) as exc:
        asyncio.run(resolve_text(request(),'key','jev',transport))
    assert 'SECRET' not in str(exc.value)


@pytest.mark.parametrize('confidence', [0, .01, .68, .99])
def test_accepted_exact_text_has_no_support_confidence_cutoff(confidence):
    result = asyncio.run(resolve_text(request(), 'key', 'jev', upstream(support_confidence=confidence)))
    assert result.status == 'resolved' and result.text == '3d printer'
    assert result.supportConfidence == confidence


def test_rejected_text_stays_unavailable_even_without_thresholds():
    result = asyncio.run(resolve_text(request(), 'key', 'jev', upstream(support='no', support_confidence=.01)))
    assert result.status == 'unavailable' and result.reason == 'unsupported'


@pytest.mark.parametrize('count', [254, 255, 500])
def test_large_instructions_select_exact_span_across_groups_within_choice_limit(count):
    # Same-width tokens also exercise the maximum legal instruction length.
    goal = ' '.join(['é'] * count)
    tokens = instruction_tokens(goal)
    first, last = 3, count - 5
    expected = goal[tokens[first].start():tokens[last].end()]
    calls = []
    def handle(req):
        body = json.loads(req.content)
        questions = body['questions']
        calls.append(set(questions))
        assert all(1 <= len(q['criteria']) <= 255 for q in questions.values())
        if 'start_group' in questions:
            answers = {}
            for name, token in [('start_group', first), ('end_group', last)]:
                group = next(key for key, value in questions[name]['criteria'].items()
                    if key != 'NONE' and value['first_token'] <= token <= value['last_token'])
                answers[name] = {'choice': group, 'confidence': .01}
        elif 'start' in questions:
            assert f't{first}' in questions['start']['criteria']
            assert f't{last}' in questions['end']['criteria']
            answers = {'start': {'choice': f't{first}', 'confidence': .01},
                       'end': {'choice': f't{last}', 'confidence': .01}}
        else:
            assert body['state']['proposed_text'] == expected
            answers = {'supported': {'choice': 'yes', 'confidence': .01}}
        return httpx.Response(200, json={'answers': answers})
    result = asyncio.run(resolve_text(request(goal), 'key', 'jev', httpx.MockTransport(handle)))
    assert result.status == 'resolved' and result.text == expected
    assert goal[result.start:result.end] == expected
    assert len(calls) == (2 if count == 254 else 3)


@pytest.mark.parametrize('group', ['NONE', 'invented'])
def test_unavailable_or_invalid_group_never_proceeds_to_text(group):
    calls = []
    def handle(req):
        calls.append(req)
        return httpx.Response(200, json={'answers': {
            'start_group': {'choice': group, 'confidence': .9},
            'end_group': {'choice': 'g1', 'confidence': .9}}})
    async def run():
        return await resolve_text(request(' '.join(['a'] * 255)), 'key', 'jev', httpx.MockTransport(handle))
    if group == 'NONE':
        assert asyncio.run(run()).status == 'unavailable'
    else:
        with pytest.raises(DecisionError, match='invalid text selection'):
            asyncio.run(run())
    assert len(calls) == 1
