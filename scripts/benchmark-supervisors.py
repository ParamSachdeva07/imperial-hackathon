"""Alternate identical, read-only planning prompts across configured providers."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
import time
import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/decision-api'))
from app.schemas import SupervisorRequest
from app.supervisor import build_payload, parse_response
from app.supervisor_providers import prepare_request, normalize_response


async def main():
    load_dotenv(ROOT / 'services/decision-api/.env')
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.runtime/supervisor-benchmark-request.json'
    request = SupervisorRequest.model_validate_json(source.read_text())
    profiles = [
        ('openai', os.getenv('OPENAI_MODEL', 'gpt-6.1-sol'), os.getenv('OPENAI_REASONING_EFFORT', 'low'), os.getenv('OPENAI_SERVICE_TIER') or None),
        ('cerebras', os.getenv('CEREBRAS_MODEL', 'qwen-3.8-27b'), os.getenv('CEREBRAS_REASONING_EFFORT', 'none'), None),
    ]
    selected = os.getenv('BENCHMARK_PROVIDERS', 'openai,cerebras').split(',')
    profiles = [profile for profile in profiles if profile[0] in selected]
    rows = []
    async with httpx.AsyncClient(timeout=55) as client:
        for trial in range(1, 4):
            for provider, model, effort, tier in profiles if trial % 2 else reversed(profiles):
                key = os.getenv(provider.upper() + '_API_KEY', '').strip()
                row = {'trial': trial, 'provider': provider, 'model': model, 'effort': effort, 'tier': tier, 'valid': False}
                started = time.perf_counter()
                try:
                    if not key: raise ValueError('Missing provider key')
                    body = build_payload(request, model, reasoning_effort=effort, service_tier=tier)
                    row['promptHash'] = hashlib.sha256((body['instructions'] + body['input'][0]['content']).encode()).hexdigest()
                    endpoint, wire = prepare_request(body, provider)
                    response = await client.post(endpoint, headers={'Authorization': 'Bearer ' + key}, json=wire)
                    row['http'] = response.status_code
                    response.raise_for_status()
                    payload = response.json()
                    plan = parse_response(normalize_response(payload, provider), request)
                    row.update(valid=True, status=plan.status, subgoal=plan.subgoal, usage=payload.get('usage'), actualTier=payload.get('service_tier'))
                except Exception as error:
                    # Neither raw provider errors nor credentials go into artifacts.
                    row['error'] = type(error).__name__
                row['seconds'] = round(time.perf_counter() - started, 3)
                rows.append(row)
                print(json.dumps(row), flush=True)
                (ROOT / '.runtime/cerebras-openai-benchmark.json').write_text(json.dumps(rows, indent=2))
    for provider, *_ in profiles:
        successful = [r['seconds'] for r in rows if r['provider'] == provider and r['valid']]
        print(json.dumps({'provider': provider, 'validTrials': len(successful), 'medianSeconds': statistics.median(successful) if successful else None}))


asyncio.run(main())
