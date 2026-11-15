/** Rough speaking-time estimate for Anam's avatar (no "finished speaking" event exists). Pure. */
const MS_PER_WORD = 400; // ~150 wpm
const PER_CHUNK_MARGIN_MS = 150;

export function estimateSpeakMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words === 0 ? 0 : words * MS_PER_WORD + PER_CHUNK_MARGIN_MS;
}
