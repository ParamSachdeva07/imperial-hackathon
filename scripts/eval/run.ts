/**
 * Evaluation harness: task × start state × arm × trials, judged by independent oracles.
 *
 *   npm run eval -- --list
 *   npm run eval -- --task chrome-new-tab --arm current,a,b --trials 10
 *   npm run eval -- --summarize .runtime/eval/<run>/results.jsonl --baseline current --candidate a
 *
 * A live run drives real applications on this Mac and spends model quota. The proxy stops any
 * action outside a task's scope before it is dispatched. Nothing here sends mail or deletes files.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-ignore The session helper is plain JavaScript shared with the smoke scripts.
import { smokeSession } from '../lib/smoke-session.mjs';
import { gate, summarize, table, type TrialResult } from './metrics';
import { TASKS, actionFromDecision, actionFromPlan, context, type Action, type EvalTask } from './tasks';

export const ARMS: Record<string, Record<string, unknown>> = {
  current: { controller: 'v1', supervisorEnabled: true, supervisorEvery: 12, maxSteps: 160 },
  a: { controller: 'v2', grounding: 'planner', maxSteps: 60, confirmIrreversible: false },
  b: { controller: 'v2', grounding: 'jev', maxSteps: 60, confirmIrreversible: false },
};
const argument = (name: string) => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1] ?? ''; };
const flag = (name: string) => process.argv.includes('--' + name);
const read = (file: string): TrialResult[] => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

function report(results: TrialResult[]) {
  const summaries = summarize(results);
  console.log(table(summaries));
  const baseline = argument('baseline'), candidate = argument('candidate');
  if (baseline && candidate) {
    const verdict = gate(summaries, baseline, candidate);
    console.log('\nGates for making arm ' + candidate + ' the default over ' + baseline + ': ' + (verdict.pass ? 'PASS' : 'NOT MET'));
    for (const reason of verdict.reasons) console.log('  - ' + reason);
  }
  return summaries;
}

async function trial(task: EvalTask, arm: string, startState: string, number: number, runDir: string, timeoutMs: number): Promise<TrialResult> {
  const c = context(process.cwd());
  const result: TrialResult = { task: task.id, family: task.family, arm, startState, trial: number, status: 'not_started',
    oraclePass: false, oracleDetail: '', duplicateAttempt: false, irreversible: task.irreversible, elapsedMs: 0, steps: 0,
    modelCalls: {}, modelMs: 0 };
  let baseline: any, session: any, state: any, guard: string | undefined;
  const attempts = new Map<string, boolean>();
  let lastPlan: { request: any; step: any } | undefined;
  const check = (action: Action | undefined, key: string, countAttempts: boolean) => {
    if (!action) return;
    const reason = task.allow(action, baseline);
    if (reason) { guard ||= reason + ': ' + action.operation + ' ' + action.label; throw new Error('Evaluation guard: ' + guard); }
    if (!countAttempts || !task.attempt) return;
    attempts.set(key, task.attempt(action));
    // The current controller dispatches what it selects, so a second attempt is stopped here.
    if ([...attempts.values()].filter(Boolean).length > 1) {
      result.duplicateAttempt = true;
      guard ||= 'duplicate attempt stopped before dispatch';
      throw new Error('Evaluation guard: ' + guard);
    }
  };
  try {
    baseline = await task.prepare(c, startState);
    session = await smokeSession('jev', (request: any, decision: any) => check(actionFromDecision(request, decision), 'd' + request.step, true), {
      env: { ASSISTANT_TRACE_DIR: path.join(runDir, 'traces') },
      validate: {
        '/navigation/plan': async (request: any, step: any) => { lastPlan = { request, step }; check(actionFromPlan(request, step), 'p' + request.step, false);
          await task.observe?.(c, baseline, request, step); },
        '/navigation/ground': (_request: any, grounded: any) => { if (lastPlan && grounded.target) check(actionFromPlan(lastPlan.request, lastPlan.step, grounded.target), 'g', false); },
      },
    });
    c.inspect = async () => {
      const reply = await session.page.evaluate(() => (window as any).desktop.inspect());
      if (!reply.ok) throw new Error(reply.error);
      return reply.data.observation;
    };
    await session.page.getByRole('heading', { name: 'Desktop Assistant' }).waitFor();
    if (flag('wait-page-bridge')) {
      const deadline = Date.now() + 35000;
      let health: any;
      do {
        health = (await session.page.evaluate(() => (window as any).desktop.health())).data;
        if (health?.pageBridge?.connected) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);
      console.log('Page bridge: ' + JSON.stringify(health?.pageBridge));
    }
    const started = performance.now();
    const accepted = await session.page.evaluate(({ goal, options }: any) => (window as any).desktop.start(
      { goal, mode: 'desktop', provider: 'jev', text: '', app: '', allowPhysical: false, inputs: [], ...options }, false),
      { goal: task.goal, options: { ...ARMS[arm], ...(flag('orchestrated') ? { orchestration: true } : {}) } });
    assert.equal(accepted.ok, true, accepted.error);
    while (performance.now() - started < timeoutMs) {
      state = (await session.page.evaluate(() => (window as any).desktop.state())).data;
      if (state.taskId && !state.busy) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    result.elapsedMs = performance.now() - started;
    if (state?.busy) { await session.page.evaluate(() => (window as any).desktop.cancel()); result.status = 'timeout'; }
    else result.status = state?.status || 'unknown';
    result.steps = state?.step || 0;
    for (const request of session.requests.filter((r: any) => r.route !== '/health')) {
      result.modelCalls[request.route] = (result.modelCalls[request.route] || 0) + 1;
      result.modelMs += request.durationMs || 0;
    }
    result.usage = session.requests.filter((r: any) => r.route !== '/health').map((r: any) => ({ route: r.route, model: r.model, usage: r.usage }));
    // The planner controller may propose an action that its own ledger withholds, so its
    // duplicates are counted from what was actually delivered.
    const trace = state?.taskId && path.join(runDir, 'traces', state.taskId + '.jsonl');
    if (ARMS[arm].controller === 'v2' && task.attempt && trace && existsSync(trace)) {
      const delivered = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .filter(line => line.kind === 'effect' && ['delivered', 'uncertain'].includes(line.data.effect.delivery))
        .filter(line => task.attempt!({ operation: line.data.effect.operation, label: line.data.effect.targetLabel, app: '', key: line.data.effect.args.key }));
      result.duplicateAttempt = delivered.length > 1;
    }
    await new Promise(resolve => setTimeout(resolve, 600));
    const verdict = await task.oracle(c, baseline, state);
    result.oraclePass = verdict.pass && !guard;
    result.oracleDetail = verdict.detail;
  } catch (error) {
    result.oracleDetail ||= 'harness error: ' + (error as Error).message;
    if (result.status === 'not_started') result.status = 'harness_error';
  } finally {
    result.guard = guard;
    await session?.close().catch(() => {});
  }
  return result;
}

async function main() {
  if (flag('list')) {
    for (const task of TASKS) console.log(task.id.padEnd(22) + task.family.padEnd(10) + task.startStates.join(',').padEnd(34) + task.goal);
    console.log('\narms: ' + Object.keys(ARMS).join(', '));
    return;
  }
  const summarizeFile = argument('summarize');
  if (summarizeFile) { report(read(summarizeFile)); return; }
  const tasks = (argument('task') || TASKS.map(t => t.id).join(',')).split(',').map(id => {
    const task = TASKS.find(t => t.id === id);
    assert.ok(task, 'Unknown task ' + id + '. Use --list.');
    return task;
  });
  const arms = (argument('arm') || 'current').split(',');
  for (const arm of arms) assert.ok(ARMS[arm], 'Unknown arm ' + arm);
  const trials = Number(argument('trials') || 10);
  assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 100, 'trials must be 1–100');
  const timeoutMs = Number(argument('timeout-s') || 300) * 1000;
  const matrix = tasks.flatMap(task => task.startStates.filter(s => !argument('state') || argument('state') === s)
    .flatMap(startState => arms.map(arm => ({ task, startState, arm }))));
  if (flag('dry-run')) {
    for (const cell of matrix) console.log(cell.task.id + ' · ' + cell.startState + ' · arm ' + cell.arm + ' · ' + trials + ' trials');
    console.log(matrix.length * trials + ' live trials would run. Nothing was started.');
    return;
  }
  const runDir = path.join(process.cwd(), '.runtime', 'eval', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(path.join(runDir, 'traces'), { recursive: true });
  const file = path.join(runDir, 'results.jsonl');
  const results: TrialResult[] = [];
  // Interleave arms within each trial number so drift in the desktop affects them equally.
  for (let number = 1; number <= trials; number++)
    for (const cell of matrix) {
      const result = await trial(cell.task, cell.arm, cell.startState, number, runDir, timeoutMs);
      results.push(result);
      appendFileSync(file, JSON.stringify(result) + '\n');
      console.log([cell.task.id, cell.startState, cell.arm, '#' + number, result.oraclePass ? 'PASS' : 'FAIL', result.status,
        Math.round(result.elapsedMs / 100) / 10 + ' s', result.guard || result.oracleDetail].join(' · '));
    }
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(report(results), null, 2));
  console.log('\nResults: ' + file);
}
await main();
