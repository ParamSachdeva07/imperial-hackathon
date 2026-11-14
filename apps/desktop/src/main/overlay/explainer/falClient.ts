/**
 * Client for our explainer-image broker (backend/explainer-broker). Never calls fal.ai directly;
 * the API key never ships in the app.
 * STUB (Phase 0): implemented by the fal track.
 *
 * getImage(prompt, styleId?):
 *  1. Local pre-generated assets first (assets/explainers/manifest.json written by
 *     scripts/pregen-demo-images.ts) → { ok:true, source:"asset" }.
 *  2. Otherwise POST {brokerUrl}/explainer/image { prompt, styleId } → { url } | { error },
 *     then fetch the url. The whole request is bounded by `timeoutMs` (default 8000).
 *  3. Images are returned as data URLs (renderer CSP allows only data: images).
 *  Never throws: failures resolve to { ok:false, error }.
 */
export type ImageResult =
  | { ok: true; dataUrl: string; source: "asset" | "broker" }
  | { ok: false; error: "timeout" | "broker_error" | "network" };

export interface ImageSource {
  getImage(prompt: string, styleId?: string): Promise<ImageResult>;
}

export interface FalClientOptions {
  brokerUrl: string;
  assetsDir: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class FalClient implements ImageSource {
  constructor(_opts: FalClientOptions) {}

  getImage(_prompt: string, _styleId?: string): Promise<ImageResult> {
    throw new Error("not implemented: FalClient.getImage");
  }
}
