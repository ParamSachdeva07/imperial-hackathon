"""Provider-specific wire formats; desktop planning and validation stay shared."""
from dataclasses import dataclass
import os


@dataclass(frozen=True)
class SupervisorConfig:
    provider: str
    key: str
    model: str
    reasoning_effort: str | None
    service_tier: str | None


def configuration() -> SupervisorConfig:
    provider = os.environ.get('SUPERVISOR_PROVIDER', 'openai').strip().lower()
    if provider not in {'openai', 'cerebras'}:
        raise ValueError('SUPERVISOR_PROVIDER must be openai or cerebras.')
    prefix = provider.upper()
    return SupervisorConfig(
        provider, os.environ.get(prefix + '_API_KEY', '').strip(),
        os.environ.get(prefix + '_MODEL', 'qwen-3.8-27b' if provider == 'cerebras' else 'gpt-6.1-sol'),
        os.environ.get(prefix + '_REASONING_EFFORT', 'none' if provider == 'cerebras' else '') or None,
        (os.environ.get('OPENAI_SERVICE_TIER', '') or None) if provider == 'openai' else None,
    )


def cerebras_schema(value):
    """Remove unsupported wire constraints; Pydantic still validates all of them."""
    if isinstance(value, list):
        return [cerebras_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {key: cerebras_schema(item) for key, item in value.items()
            if key not in {'minItems', 'maxItems', 'minLength', 'maxLength', 'format', 'pattern'}}


def prepare_request(body: dict, provider: str) -> tuple[str, dict]:
    if provider == 'openai':
        return 'https://api.openai.com/v1/responses', body
    if provider != 'cerebras':
        raise ValueError('Unsupported supervisor provider')
    schema = cerebras_schema(body['text']['format']['schema'])
    # Keep evidence constrained to observed IDs. Reserve enum capacity for
    # other fields when a large catalog exceeds Cerebras's 500-value limit.
    items = schema['properties']['evidence']['items']
    identifiers = items.pop('enum', [])
    def enum_count(value):
        if isinstance(value, list): return sum(enum_count(item) for item in value)
        if not isinstance(value, dict): return 0
        return len(value.get('enum', [])) + sum(enum_count(item) for key, item in value.items() if key != 'enum')
    if identifiers:
        items['enum'] = identifiers[:max(0, 500 - enum_count(schema))]
    return 'https://api.cerebras.ai/v1/chat/completions', {
        'model': body['model'],
        'messages': [{'role': 'system', 'content': body['instructions']}, *body['input']],
        'max_completion_tokens': body['max_output_tokens'],
        'reasoning_effort': body.get('reasoning', {}).get('effort', 'none'),
        'response_format': {'type': 'json_schema', 'json_schema': {
            'name': 'desktop_supervisor_plan', 'strict': True, 'schema': schema,
        }},
    }


def normalize_response(payload: dict, provider: str) -> dict:
    if provider == 'openai':
        return payload
    choices = payload['choices']
    if len(choices) != 1 or choices[0]['finish_reason'] != 'stop':
        raise ValueError('Incomplete or ambiguous supervisor response')
    message = choices[0]['message']
    if message.get('refusal') or message.get('tool_calls') or not isinstance(message.get('content'), str):
        raise ValueError('Supervisor did not return a structured plan')
    return {'status': 'completed', 'output': [{'type': 'message', 'content': [
        {'type': 'output_text', 'text': message['content']},
    ]}]}
