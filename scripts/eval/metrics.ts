/** Pure aggregation for the evaluation harness. Success is judged by the oracle, never by the controller. */
export type TrialResult = {
  task: string; family: string; arm: string; startState: string; trial: number;
  status: string; oraclePass: boolean; oracleDetail: string;
  /** The proxy stopped an out-of-scope action before dispatch. */
  guard?: string;
  /** A second attempt at an effect that was requested once. */
  duplicateAttempt: boolean;
  irreversible: boolean;
  elapsedMs: number; steps: number;
  modelCalls: Record<string, number>; modelMs: number;
  usage?: { route: string; model: string; usage?: { provider: string; inputTokens: number; outputTokens: number; cachedInputTokens: number } }[];
};
export type Summary = {
  task: string; family: string; arm: string; n: number;
  success: number; successRate: number; successInterval: [number, number];
  /** Controller reported `completed` and the oracle disagreed. */
  falseCompletion: number; falseCompletionRate: number;
  /** Controller reported `completed_unverified` and the oracle found the work not done. Not a false claim, but not a result. */
  unverifiedAndWrong: number;
  duplicateAttempts: number; irreversibleDuplicates: number; guardStops: number;
  statuses: Record<string, number>;
  timeP50: number; timeP90: number; modelMsP50: number; nativeAndOtherMsP50: number;
  stepsP50: number; modelCallsMean: number;
};

/** Wilson score interval: honest at the small trial counts this harness runs. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = successes / n, denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function summarize(results: TrialResult[]): Summary[] {
  const groups = new Map<string, TrialResult[]>();
  for (const result of results) {
    const key = result.task + '\u0000' + result.arm;
    groups.set(key, [...(groups.get(key) || []), result]);
  }
  return [...groups.values()].map(group => {
    const n = group.length, success = group.filter(r => r.oraclePass).length;
    const falseCompletion = group.filter(r => r.status === 'completed' && !r.oraclePass).length;
    const statuses: Record<string, number> = {};
    for (const r of group) statuses[r.status] = (statuses[r.status] || 0) + 1;
    return {
      task: group[0].task, family: group[0].family, arm: group[0].arm, n, success, successRate: success / n,
      successInterval: wilson(success, n), falseCompletion, falseCompletionRate: falseCompletion / n,
      unverifiedAndWrong: group.filter(r => r.status === 'completed_unverified' && !r.oraclePass).length,
      duplicateAttempts: group.filter(r => r.duplicateAttempt).length,
      irreversibleDuplicates: group.filter(r => r.duplicateAttempt && r.irreversible).length,
      guardStops: group.filter(r => r.guard).length, statuses,
      timeP50: percentile(group.map(r => r.elapsedMs), 50), timeP90: percentile(group.map(r => r.elapsedMs), 90),
      modelMsP50: percentile(group.map(r => r.modelMs), 50),
      nativeAndOtherMsP50: percentile(group.map(r => Math.max(0, r.elapsedMs - r.modelMs)), 50),
      stepsP50: percentile(group.map(r => r.steps), 50),
      modelCallsMean: group.reduce((total, r) => total + Object.values(r.modelCalls).reduce((a, b) => a + b, 0), 0) / n,
    };
  }).sort((a, b) => a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm));
}

/** The proposed gates for making a candidate arm the default (docs/controller-redesign.md, section 11). */
export function gate(summaries: Summary[], baselineArm: string, candidateArm: string,
  options: { minTrials?: number; successFloor?: number } = {}): { pass: boolean; reasons: string[] } {
  const { minTrials = 10, successFloor = 0.8 } = options;
  const reasons: string[] = [];
  const candidate = summaries.filter(s => s.arm === candidateArm);
  if (!candidate.length) return { pass: false, reasons: ['No results for arm ' + candidateArm + '.'] };
  // Being no worse than a failing baseline, or untested where the baseline was tested, is not a pass.
  for (const b of summaries.filter(s => s.arm === baselineArm))
    if (!candidate.some(c => c.task === b.task)) reasons.push(b.task + ': arm ' + candidateArm + ' has no results for a task the baseline ran.');
  for (const c of candidate) {
    if (c.n < minTrials) reasons.push(c.task + ': ' + c.n + ' trial(s) is fewer than the ' + minTrials + ' needed.');
    if (c.successRate < successFloor) reasons.push(c.task + ': success ' + c.success + '/' + c.n + ' is below the floor of ' + Math.round(successFloor * 100) + '%.');
    const b = summaries.find(s => s.arm === baselineArm && s.task === c.task);
    if (c.irreversibleDuplicates) reasons.push(c.task + ': ' + c.irreversibleDuplicates + ' duplicate irreversible attempt(s).');
    if (c.falseCompletionRate >= 0.05) reasons.push(c.task + ': false completion rate ' + (c.falseCompletionRate * 100).toFixed(0) + '% is not below 5%.');
    if (!b) { reasons.push(c.task + ': no baseline results to compare against.'); continue; }
    if (c.falseCompletionRate > b.falseCompletionRate) reasons.push(c.task + ': more false completions than ' + baselineArm + '.');
    if (c.successRate < b.successRate) reasons.push(c.task + ': success ' + c.success + '/' + c.n + ' is below ' + baselineArm + ' ' + b.success + '/' + b.n + '.');
    if (c.timeP50 > b.timeP50) reasons.push(c.task + ': median time ' + Math.round(c.timeP50) + ' ms is slower than ' + Math.round(b.timeP50) + ' ms.');
  }
  return { pass: !reasons.length, reasons };
}

export function table(summaries: Summary[]): string {
  const rows = summaries.map(s => [s.task, s.arm, s.success + '/' + s.n,
    Math.round(s.successInterval[0] * 100) + '–' + Math.round(s.successInterval[1] * 100) + '%', String(s.falseCompletion), String(s.unverifiedAndWrong),
    String(s.duplicateAttempts), (s.timeP50 / 1000).toFixed(1) + ' s', (s.timeP90 / 1000).toFixed(1) + ' s',
    (s.modelMsP50 / 1000).toFixed(1) + ' s', String(s.stepsP50), s.modelCallsMean.toFixed(1),
    Object.entries(s.statuses).map(([k, v]) => k + ':' + v).join(' ')]);
  const header = ['task', 'arm', 'success', '95% interval', 'false done', 'unverified+wrong', 'dup', 'p50', 'p90', 'model p50', 'steps', 'calls', 'statuses'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  return [header, ...rows].map(r => r.map((cell, i) => cell.padEnd(widths[i])).join('  ')).join('\n');
}
