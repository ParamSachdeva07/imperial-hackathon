import type { DesktopCandidate, Element } from '../../../../packages/contracts/src/index';

export class WriteHistory {
  private completed = new Map<string, string>();

  clear(): void {
    this.completed.clear();
  }

  private key(phase: number, candidate: DesktopCandidate, target: Element, text: string): string {
    return JSON.stringify([
      phase,
      candidate.app,
      candidate.windowId,
      target.role,
      target.nativeId,
      target.name,
      target.path,
      text,
    ]);
  }

  alreadyApplied(
    phase: number,
    candidate: DesktopCandidate,
    target: Element | undefined,
    text: string | undefined,
  ): boolean {
    if (!target || text === undefined) return false;
    return this.completed.get(this.key(phase, candidate, target, text)) === target.value;
  }

  record(
    phase: number,
    candidate: DesktopCandidate,
    target: Element | undefined,
    text: string | undefined,
    verifiedValue: string | undefined,
  ): void {
    if (!target || text === undefined || verifiedValue === undefined) return;
    this.completed.set(this.key(phase, candidate, target, text), verifiedValue);
  }
}
