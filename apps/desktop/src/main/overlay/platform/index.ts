import { macPlatform } from "./mac";
import type { OverlayPlatform } from "./types";

export type { OverlayPlatform } from "./types";

/** macOS first. Other platforms get an adapter later (spec §0). */
export function getOverlayPlatform(): OverlayPlatform {
  if (process.platform === "darwin") return macPlatform;
  throw new Error(`Pointy overlay: platform "${process.platform}" is not supported yet (macOS only).`);
}
