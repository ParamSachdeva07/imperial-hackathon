/** Local (non-contract) accessibility element types. No electron imports. */
import type { BoundsProvider, Rect } from "@pointy/shared/overlay";

export interface ElementInfo {
  id: string;
  role: string;
  label: string;
  window: string;
  /** Global DIP rect. */
  rect: Rect;
  displayId: string;
  focused?: boolean;
}

export interface ElementSnapshot {
  app: string;
  pid?: number;
  window: string;
  elements: ElementInfo[];
  truncated: boolean;
  rev: number;
}

export interface AxProvider extends BoundsProvider {
  listElements(): ElementInfo[];
  snapshotNow(reason: string): Promise<ElementSnapshot>;
  /** Element under a global point, or null. Never throws. */
  elementAt?(point: { x: number; y: number }): Promise<ElementInfo | null>;
  readonly trusted: boolean;
  onTrustedChange?(cb: (trusted: boolean) => void): () => void;
}
