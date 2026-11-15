/** Where an explainer card's picture comes from. No source is configured by default: panels show their fallback icon. */
export type ImageResult =
  | { ok: true; dataUrl: string; source: "asset" | "broker" }
  | { ok: false; error: "timeout" | "broker_error" | "network" };

export interface ImageSource {
  getImage(prompt: string, styleId?: string): Promise<ImageResult>;
}
