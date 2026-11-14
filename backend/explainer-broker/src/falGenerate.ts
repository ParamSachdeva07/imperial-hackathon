import { fal } from "@fal-ai/client";
import type { DownloadFn, GenerateFn } from "./imageService.js";

/** Fast default; see README.md for the model choice. */
export const DEFAULT_MODEL_ID = "fal-ai/flux/schnell";

/** Real fal call via the official client (`fal.subscribe` on the queue; the result is in `.data`). */
export function makeFalGenerate(modelId: string, apiKey: string): GenerateFn {
  fal.config({ credentials: apiKey });
  return async (fullPrompt) => {
    const result = await fal.subscribe(modelId, {
      input: {
        prompt: fullPrompt,
        image_size: { width: 640, height: 640 },
        num_inference_steps: 4,
        num_images: 1,
        output_format: "jpeg",
      },
    });
    const data = result.data as { images?: Array<{ url?: string }> };
    const url = data.images?.[0]?.url;
    if (!url) throw new Error("fal returned no image");
    return { url };
  };
}

export const fetchDownload: DownloadFn = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "image/jpeg",
  };
};
