"""Preserve provider-reported billing counters; absence is unknown, never zero usage."""
from .schemas import ModelUsage


def model_usage(payload: dict, provider: str) -> ModelUsage | None:
    usage = payload.get('usage') or {}
    incoming = usage.get('input_tokens', usage.get('prompt_tokens'))
    outgoing = usage.get('output_tokens', usage.get('completion_tokens', 0 if provider == 'typesafe' else None))
    if not isinstance(incoming, int) or not isinstance(outgoing, int):
        return None
    details = usage.get('input_tokens_details', usage.get('prompt_tokens_details')) or {}
    return ModelUsage(provider=provider, inputTokens=incoming, outputTokens=outgoing,
                      cachedInputTokens=details.get('cached_tokens', 0))
