/**
 * Batches streamed text deltas into speakable chunks (whole sentences) for Anam's talk stream.
 * Pure. Emits a chunk (keeping its trailing whitespace so concatenating chunks reproduces the text) once it ends at a sentence boundary and has at least `minChars`
 * (the first chunk uses the smaller `firstMinChars` so speech starts sooner), or when it grows past
 * `maxChars` (cut at the last space). The remainder is returned by flush().
 */
export interface SentenceBatcherOptions {
  firstMinChars?: number;
  minChars?: number;
  maxChars?: number;
}

const TERMINATOR = /[.!?…]+["'”’)\]]*\s|\n/g;

export class SentenceBatcher {
  private buf = "";
  private emitted = 0;
  private readonly firstMin: number;
  private readonly min: number;
  private readonly max: number;

  constructor(opts: SentenceBatcherOptions = {}) {
    this.firstMin = opts.firstMinChars ?? 12;
    this.min = opts.minChars ?? 60;
    this.max = opts.maxChars ?? 400;
  }

  /** Feed a delta; returns zero or more chunks ready to speak. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const need = this.emitted === 0 && out.length === 0 ? this.firstMin : this.min;
      const cut = this.findCut(need);
      if (cut < 0) break;
      // Keep the trailing separator: Anam concatenates chunks verbatim ("top." + "Then" would fuse).
      const raw = this.buf.slice(0, cut);
      const chunk = this.emitted === 0 && out.length === 0 ? raw.trimStart() : raw;
      this.buf = this.buf.slice(cut);
      if (chunk.trim()) {
        out.push(chunk);
        this.emitted++;
      }
    }
    return out;
  }

  /** The unspoken remainder (trailing whitespace trimmed, possibly empty); resets the batcher. */
  flush(): string {
    const rest = this.emitted === 0 ? this.buf.trim() : this.buf.trimEnd();
    this.reset();
    return rest;
  }

  /** Drop everything (interrupt / new response). */
  reset(): void {
    this.buf = "";
    this.emitted = 0;
  }

  /** Index just after the cut point, or -1. */
  private findCut(need: number): number {
    TERMINATOR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TERMINATOR.exec(this.buf))) {
      const end = m.index + m[0].length;
      if (this.buf.slice(0, end).trim().length >= need) return end;
    }
    if (this.buf.length > this.max) {
      const sp = this.buf.lastIndexOf(" ", this.max - 1);
      return sp > 0 ? sp + 1 : this.max;
    }
    if (this.emitted === 0) {
      // No sentence end yet: start speaking after the 6th word so the first sound is not delayed by a long first sentence.
      const w = this.buf.match(/^\s*(?:\S+\s+){6}/);
      if (w) return w[0].length;
    }
    return -1;
  }
}
