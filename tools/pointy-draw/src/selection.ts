/** Pure helpers for `pointy-draw selection`: turn GET /debug/selection into files. */
import { snapshotMeta, type SelectionSnapshot, type SelectionSnapshotMeta } from "@pointy/shared/context/selection";

export interface SelectionFiles {
  fullJpg: Buffer;
  focusJpg: Buffer;
  meta: SelectionSnapshotMeta;
}

export function decodeDataUrl(dataUrl: string): Buffer {
  const m = /^data:image\/jpeg;base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("not a jpeg data URL");
  return Buffer.from(m[1] as string, "base64");
}

/** null when the response carries no snapshot. */
export function selectionFiles(response: unknown): SelectionFiles | null {
  const snap = (response as { snapshot?: SelectionSnapshot | null } | null)?.snapshot;
  if (!snap) return null;
  return { fullJpg: decodeDataUrl(snap.full.dataUrl), focusJpg: decodeDataUrl(snap.focus.dataUrl), meta: snapshotMeta(snap) };
}

/** Inverse of selectionFiles: rebuild a full snapshot from the exported meta + the two JPEGs. */
export function snapshotFromFiles(meta: SelectionSnapshotMeta, fullJpg: Buffer, focusJpg: Buffer): SelectionSnapshot {
  const url = (b: Buffer) => `data:image/jpeg;base64,${b.toString("base64")}`;
  const { bytes: _fb, ...full } = meta.full;
  const { bytes: _cb, ...focus } = meta.focus;
  return { ...meta, full: { ...full, dataUrl: url(fullJpg) }, focus: { ...focus, dataUrl: url(focusJpg) } };
}
