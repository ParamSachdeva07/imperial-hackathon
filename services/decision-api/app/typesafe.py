"""Shared provider boundary for every TypeSafe question, including text resolution."""
import httpx

ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
MAX_CHOICES = 255


class DecisionError(Exception):
    pass


def validate_questions(body: dict) -> None:
    for name, question in body.get('questions', {}).items():
        if question.get('type') != 'choice':
            continue
        criteria = question.get('criteria')
        if not isinstance(criteria, dict) or not criteria:
            raise DecisionError(f'Jev question {name} requires nonempty choice criteria. No desktop action was sent.')
        if len(criteria) > MAX_CHOICES:
            raise DecisionError(f'Jev question {name} has {len(criteria)} choices; maximum is {MAX_CHOICES}, including navigation. Narrow the question before inference. No desktop action was sent.')


async def ask(client: httpx.AsyncClient, key: str, body: dict) -> dict:
    validate_questions(body)
    response = await client.post(ENDPOINT, headers={'Authorization': 'Bearer ' + key}, json=body)
    if response.status_code in (401, 403):
        raise DecisionError('TypeSafe rejected the API key. Check the backend environment file.')
    if response.status_code == 429:
        raise DecisionError('TypeSafe rate limit or quota reached. No desktop action was sent.')
    if response.status_code == 400:
        try:
            detail = str(response.json()).lower()
        except ValueError:
            detail = ''
        if any(term in detail for term in ('max_tokens', 'token limit', 'context length')):
            raise DecisionError('Jev input exceeded its context limit. No desktop action was sent.')
    if response.status_code == 422:
        # Never echo provider input fields, which may contain private UI text.
        raise DecisionError('TypeSafe rejected the question format (HTTP 422). No desktop action was sent.')
    response.raise_for_status()
    return response.json()
