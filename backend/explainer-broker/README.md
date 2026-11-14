# Explainer image broker

Localhost-only HTTP service that turns a prompt into an illustration via fal.ai. The `FAL_KEY` lives
only here (repo-root `.env`, gitignored) and never ships in the app.

```
npm run broker            # tsx src/server.ts, binds 127.0.0.1:${EXPLAINER_BROKER_PORT:-47620}
POST /explainer/image     { prompt (1-300 chars), styleId? }  ->  200 { url } | 4xx/5xx { error }
GET  /explainer/files/<sha256>.<png|jpg|webp>                  ->  cached image bytes
```

- The style suffix (spec 7.3, "no text, no letters, ...") is appended to every prompt server-side.
- Cache key = `sha256(modelId + prompt + styleId)`; images are downloaded into `.cache/` (gitignored)
  and served from the broker, so returned URLs never expire. A hit never calls fal; concurrent
  identical requests share one fal call. Failures are not cached.
- Hardening: 8 KB body limit, JSON content-type only, strict file-name regex (no traversal).

## fal client call (verified against `@fal-ai/client@1.11.0` types and fal.ai's model page)

```ts
fal.config({ credentials: FAL_KEY });
const result = await fal.subscribe(modelId, { input: { prompt, image_size: { width: 640, height: 640 },
  num_inference_steps: 4, num_images: 1, output_format: "jpeg" } });
result.data.images[0].url
```

## Model choice

Default: `fal-ai/flux/schnell` (FLUX.1 [schnell], 1-4 step distilled, fal markets it as sub-second;
independent reviews report roughly 1-2 s per image on fal). Override with `FAL_MODEL_ID`.

Latency measurements (2026-11-14, from a London laptop, `fal.subscribe` end-to-end incl. queue,
640×640, 1 image, style suffix appended; 3 calls each + the 5 pregen calls for schnell):

| Model | Notes | Measured (ms) | Median |
| --- | --- | --- | --- |
| `fal-ai/flux/schnell` | **default**, 4 steps | 1744, 1014, 1406 (pregen: 2097–2529 incl. download) | **~1.4 s** |
| `fal-ai/flux-2/turbo` | distilled FLUX.2 | 2223, 1888, 1892 | ~1.9 s |
| `fal-ai/z-image/turbo` | | 1806, 3065, 1052 | ~1.8 s (high variance) |

All three IDs resolved on fal. schnell is fastest and steadiest, so it stays the default; all are
well inside the 8 s client timeout. Pre-generated images live in `assets/explainers/` and are used
first, so the live demo never depends on fal responding.

Update the table and `DEFAULT_MODEL_ID` in `src/falGenerate.ts` after measuring.
