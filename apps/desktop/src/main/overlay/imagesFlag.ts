/** The explainer-pictures switch (no electron imports: unit-tested). Pictures are an opt-in feature, off by default. */
import { FalClient, type ImageSource } from "./explainer/falClient";

export const DEFAULT_BROKER_URL = "http://127.0.0.1:47620";

/** POINTY_IMAGES=1 turns on explainer pictures (pre-generated assets + the fal.ai broker). Anything else: off. */
export function imagesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["POINTY_IMAGES"] === "1";
}

/**
 * The picture source for the overlay. An explicit `imageSource` wins; otherwise a FalClient only when `images` is on and an
 * assetsDir is given. Off (the default) means no source at all: no broker calls, no pregenerated assets, fallback icons only.
 */
export function resolveImageSource(opts: { images?: boolean; assetsDir?: string; brokerUrl?: string; imageSource?: ImageSource }): ImageSource | undefined {
  if (opts.imageSource) return opts.imageSource;
  if (!opts.images || !opts.assetsDir) return undefined;
  return new FalClient({ brokerUrl: opts.brokerUrl ?? DEFAULT_BROKER_URL, assetsDir: opts.assetsDir });
}
