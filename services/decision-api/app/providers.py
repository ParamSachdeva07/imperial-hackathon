"""One structured-output call to OpenAI or Cerebras. Nothing here sends desktop input."""
from dataclasses import dataclass
import os
from typing import Literal
import httpx
from .schemas import ModelUsage


class ModelError(Exception):
    """`retryable` is false when an identical request would fail again."""
    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class ModelConfig:
    provider: str
    key: str
    model: str
    reasoning_effort: str | None
    service_tier: str | None


def configuration(role: Literal['navigator', 'orchestrator'] = 'navigator') -> ModelConfig:
    # SUPERVISOR_PROVIDER is the name older .env files use for the navigator's provider.
    base = os.environ.get('NAVIGATOR_PROVIDER') or os.environ.get('SUPERVISOR_PROVIDER', 'cerebras')
    provider = (os.environ.get('ORCHESTRATOR_PROVIDER', base) if role == 'orchestrator' else base).strip().lower()
    if provider not in {'openai', 'cerebras'}:
        raise ValueError(role.upper() + '_PROVIDER must be openai or cerebras.')
    prefix = provider.upper()

    def option(name: str, default: str = '') -> str:
        value = os.environ.get(prefix + '_' + name, default)
        return os.environ.get('ORCHESTRATOR_' + name, value) if role == 'orchestrator' else value
    return ModelConfig(
        provider, os.environ.get(prefix + '_API_KEY', '').strip(),
        option('MODEL', 'qwen-3.8-27b' if provider == 'cerebras' else 'gpt-6-luna'),
        option('REASONING_EFFORT', 'low' if provider == 'cerebras' else '') or None,
        (option('SERVICE_TIER') or None) if provider == 'openai' else None,
    )


def compact(value):
    """Drop empty fields so the model reads facts, not padding."""
    if isinstance(value, dict):
        return {key: compact(item) for key, item in value.items()
                if item not in ('', [], None, False) or key in ('complete', 'focused')}
    if isinstance(value, list):
        return [compact(item) for item in value]
    return value


def _cerebras_schema(value):
    """Remove constraints Cerebras does not accept; Pydantic still validates all of them."""
    if isinstance(value, list):
        return [_cerebras_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {key: _cerebras_schema(item) for key, item in value.items()
            if key not in {'minItems', 'maxItems', 'minLength', 'maxLength', 'format', 'pattern'}}


def _request(config: ModelConfig, instructions: str, messages: list[str], schema: dict, name: str, max_tokens: int) -> tuple[str, dict]:
    inputs = [{'role': 'user', 'content': message} for message in messages]
    if config.provider == 'cerebras':
        return 'https://api.cerebras.ai/v1/chat/completions', {
            'model': config.model,
            'messages': [{'role': 'system', 'content': instructions}, *inputs],
            'max_completion_tokens': max_tokens,
            'reasoning_effort': config.reasoning_effort or 'none',
            'response_format': {'type': 'json_schema', 'json_schema': {'name': name, 'strict': True, 'schema': _cerebras_schema(schema)}},
        }
    body = {'model': config.model, 'store': False, 'instructions': instructions, 'input': inputs, 'max_output_tokens': max_tokens,
            'text': {'format': {'type': 'json_schema', 'name': name, 'strict': True, 'schema': schema}}}
    if config.reasoning_effort:
        body['reasoning'] = {'effort': config.reasoning_effort}
    if config.service_tier:
        body['service_tier'] = config.service_tier
    return 'https://api.openai.com/v1/responses', body


def _text(payload: dict, provider: str) -> str:
    """The model's one final answer: never commentary, a refusal or a cut-off reply."""
    if provider == 'cerebras':
        choices = payload['choices']
        message = choices[0]['message']
        if len(choices) != 1 or choices[0]['finish_reason'] != 'stop' or message.get('refusal') or message.get('tool_calls'):
            raise ValueError('incomplete or ambiguous reply')
        text = message.get('content')
    else:
        if payload.get('status') != 'completed':
            raise ValueError('incomplete reply (' + str((payload.get('incomplete_details') or {}).get('reason', payload.get('status'))) + ')')
        messages = [item for item in payload.get('output', []) if item.get('type') == 'message' and item.get('role', 'assistant') == 'assistant']
        finals = [item for item in messages if item.get('phase') == 'final_answer'] or [item for item in messages if item.get('phase') is None]
        if len(finals) != 1 or any(part.get('type') == 'refusal' for part in finals[0].get('content', [])):
            raise ValueError('no single final answer')
        text = ''.join(part['text'] for part in finals[0].get('content', []) if part.get('type') == 'output_text')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('empty reply')
    return text


def _usage(payload: dict, provider: str) -> ModelUsage | None:
    """Provider-reported counters; absence is unknown, never zero."""
    usage = payload.get('usage') or {}
    incoming = usage.get('input_tokens', usage.get('prompt_tokens'))
    outgoing = usage.get('output_tokens', usage.get('completion_tokens'))
    if not isinstance(incoming, int) or not isinstance(outgoing, int):
        return None
    details = usage.get('input_tokens_details', usage.get('prompt_tokens_details')) or {}
    return ModelUsage(provider=provider, inputTokens=incoming, outputTokens=outgoing, cachedInputTokens=details.get('cached_tokens', 0))


async def ask(config: ModelConfig, role: str, instructions: str, messages: list[str], schema: dict, *, max_tokens: int,
              timeout: float, client: httpx.AsyncClient | None = None) -> tuple[str, ModelUsage | None]:
    """Returns the model's JSON text and its token usage, or raises ModelError."""
    endpoint, body = _request(config, instructions, messages, schema, 'desktop_' + role, max_tokens)
    try:
        if client is None:
            async with httpx.AsyncClient() as owned:
                response = await owned.post(endpoint, headers={'Authorization': 'Bearer ' + config.key}, json=body, timeout=timeout)
        else:
            response = await client.post(endpoint, headers={'Authorization': 'Bearer ' + config.key}, json=body, timeout=timeout)
        if response.status_code >= 400:
            try:
                error = response.json().get('error') or {}
                code = str(error.get('code') or error.get('type') or '')[:100]
            except (ValueError, AttributeError):
                code = ''
            status = response.status_code
            retryable = (status in (408, 409, 429) or status >= 500) and code not in ('insufficient_quota', 'credit_balance_exhausted')
            raise ModelError(f'The {role} model returned HTTP {status}' + (f' ({code})' if code else '') + '. No desktop action was sent.', retryable)
        payload = response.json()
        return _text(payload, config.provider), _usage(payload, config.provider)
    except ModelError:
        raise
    except httpx.TimeoutException as exc:
        raise ModelError(f'The {role} model did not answer in time. No desktop action was sent.') from exc
    except (httpx.HTTPError, ValueError, KeyError, TypeError, IndexError) as exc:
        raise ModelError(f'The {role} model returned no usable answer ({str(exc)[:120] or type(exc).__name__}). No desktop action was sent.') from exc
