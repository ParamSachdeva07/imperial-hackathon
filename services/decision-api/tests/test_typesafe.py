import asyncio
import httpx
import pytest
from app.typesafe import MAX_CHOICES, DecisionError, ask, validate_questions


def question(count):
    return {'type': 'choice', 'criteria': {str(i): str(i) for i in range(count)}}


def test_limit_applies_per_question_not_to_sum_or_noul():
    validate_questions({'questions': {'start': question(MAX_CHOICES), 'end': question(MAX_CHOICES),
                                    'done': {'type': 'noul', 'instructions': 'Is the goal complete?'}}})


@pytest.mark.parametrize('count', [0, 256])
def test_every_question_is_checked_before_network_request(count):
    async def run():
        transport = httpx.MockTransport(lambda _: pytest.fail('Invalid choices must not reach provider'))
        async with httpx.AsyncClient(transport=transport) as client:
            await ask(client, 'key', {'questions': {'first': question(2), 'second': question(count)}})
    with pytest.raises(DecisionError, match='second'):
        asyncio.run(run())


def test_format_rejection_is_sanitized():
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda _: httpx.Response(422, json={'input': 'private text'}))) as client:
            await ask(client, 'key', {'questions': {'valid': question(2)}})
    with pytest.raises(DecisionError, match='HTTP 422') as error:
        asyncio.run(run())
    assert 'private text' not in str(error.value)
