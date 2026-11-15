/** Paired live-model trials in an isolated browser, using the real extension and controller.
 * Independent DOM oracles judge effects; controller completion alone never passes a trial.
 * No user profile, documents or external messages are touched. */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { PageBridgeServer } from '../../apps/desktop/electron/page/page-bridge-server';
import { PageWorkspace } from '../../apps/desktop/electron/page/page-workspace';
import { PlannerLoop, type PlannerHost } from '../../apps/desktop/electron/controller/v2/planner-loop';
import { NavigationOrchestrator } from '../../apps/desktop/electron/controller/v2/orchestrator';
import { JevDecisionClient, type DecisionProvider } from '../../apps/desktop/electron/services/decision-client';
import { TaskInputSchema, type ControllerState } from '../../packages/contracts/src/index';
import type { WorkspaceBridge } from '../../apps/desktop/electron/desktop/workspace';

const trials = Number(process.env.EVAL_TRIALS || 3);
const root = path.resolve('.runtime/eval/target-selection-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(root, { recursive: true });
const tasks = [
  { id: 'search', goal: 'Search the product catalogue for rag and show the results.',
    html: `<form aria-label="Newsletter"><input aria-label="Newsletter email"><button>Subscribe</button></form>
      <form id="f" aria-label="Product catalogue"><input aria-label="Search products"><button>Search</button></form><p id="result">No results yet</p>
      <script>f.onsubmit=e=>{e.preventDefault();window.count++;result.textContent='Results for '+f.querySelector('input').value}</script>`,
    expected: 'Results for rag' },
  { id: 'duplicate-label', goal: 'Open the details for the Green project, leaving the Blue project unchanged.',
    html: `<section aria-label="Blue project"><h2>Blue project</h2><button onclick="window.wrong++;result.textContent='Blue project details'">Details</button></section>
      <section aria-label="Green project"><h2>Green project</h2><button onclick="window.count++;result.textContent='Green project details'">Details</button></section><p id="result">Choose a project</p>`,
    expected: 'Green project details' },
  { id: 'menu', goal: 'Change the display theme to Dark through the settings menu.',
    html: `<button onclick="document.querySelector('nav').hidden=false">Settings</button><nav aria-label="Settings" hidden><button onclick="window.count++;result.textContent='Display theme: Dark';this.parentElement.hidden=true">Dark</button><button>Light</button></nav><p id="result">Display theme: Light</p>`,
    expected: 'Display theme: Dark' },
  { id: 'apply', goal: 'Set the document font size to 24 and apply the change.',
    html: `<main><label>Font size <input id="size" value="12"></label><button onclick="window.count++;setTimeout(()=>result.textContent='Applied document font size: '+size.value,250)">Apply</button><p id="result">Applied document font size: 12</p></main>`,
    expected: 'Applied document font size: 24' },
];
const site = http.createServer((req, res) => {
  const task = tasks.find(t => '/' + t.id === req.url?.split('?')[0])!;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Navigation evaluation</title><style>body{font:18px sans-serif}section,form{padding:15px}</style><script>window.count=0;window.wrong=0</script>' + (task?.html || 'Not found'));
});
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + (site.address() as any).port;
const server = new PageBridgeServer(0);
if (!await server.start()) throw new Error('Could not start isolated page bridge');
const extension = mkdtempSync(path.join(os.tmpdir(), 'navigation-eval-extension-'));
cpSync(path.resolve('extension/page-bridge'), extension, { recursive: true });
const worker = path.join(extension, 'background.js');
writeFileSync(worker, readFileSync(worker, 'utf8').replace('127.0.0.1:8767', '127.0.0.1:' + server.port));
const browser = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'navigation-eval-browser-')), {
  executablePath: process.env.PAGE_BRIDGE_CHROMIUM, headless: true,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
});
const client = new JevDecisionClient(process.env.EVAL_API_URL || 'http://127.0.0.1:62140', process.env.EVAL_API_TOKEN || 'local-eval-session', []);
const results: any[] = [];
try {
  const page = browser.pages()[0];
  await page.goto(base + '/search');
  const deadline = Date.now() + 15000;
  while (!server.connected && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  if (!server.connected) throw new Error('Extension did not connect');
  const modes = process.env.EVAL_ORCHESTRATED === '1' ? [true] : [false];
  for (let trial = 1; trial <= trials; trial++) for (const task of tasks) for (const orchestration of modes)
    for (const arm of trial % 2 ? ['planner', 'jev'] as const : ['jev', 'planner'] as const) {
      await page.goto(base + '/' + task.id);
      const workspace = new PageWorkspace(server);
      const bridge: WorkspaceBridge = {
        applications: async () => [],
        observe: (_context, signal, options) => workspace.observe('Google Chrome', [], signal, options?.query),
        act: (candidate, observation, text, _physical, signal) => workspace.act(candidate, observation, text, signal),
        takeActionReport: () => workspace.takeActionReport(),
      };
      const calls: any[] = [], traces: any[] = [];
      const metered = (name: 'plan' | 'ground' | 'orchestrate') => async (request: any, signal: AbortSignal) => {
        const start = performance.now();
        const result = await client[name](request, signal);
        calls.push({ route: name, ms: performance.now() - start, model: result.model, usage: result.usage });
        return result;
      };
      const provider: DecisionProvider = { decide: client.decide.bind(client), plan: metered('plan'), ground: metered('ground'), orchestrate: metered('orchestrate') };
      const state: ControllerState = { taskId: randomUUID(), status: 'idle', busy: true, document: null, snapshot: null,
        decision: null, step: 0, verifiedText: null, events: [], input: TaskInputSchema.parse({ provider: 'jev',
          goal: task.goal, app: 'Google Chrome', controller: 'v2', grounding: arm, orchestration, maxSteps: 16, confirmIrreversible: false }) };
      const host: PlannerHost = { state, status: (status, message) => { state.status = status; traces.push({ kind: 'status', status, message }); },
        event: () => {}, trace: (kind, data) => traces.push({ kind, data }) };
      const started = performance.now();
      let error = '';
      try {
        const runner = orchestration ? new NavigationOrchestrator(bridge, provider) : new PlannerLoop(bridge, provider);
        await runner.advance(host, false, AbortSignal.timeout(90000));
      } catch (e) { error = (e as Error).message; }
      const actual = await page.evaluate(() => ({ text: document.getElementById('result')?.textContent, count: (window as any).count, wrong: (window as any).wrong }));
      const result = { task: task.id, trial, arm, orchestration, status: state.status, elapsedMs: performance.now() - started,
        steps: state.step, oraclePass: actual.text === task.expected && actual.count === 1 && actual.wrong === 0,
        actual, error, calls, agreements: traces.filter(t => t.kind === 'grounding').map(t => t.data.agree) };
      results.push(result);
      appendFileSync(path.join(root, 'results.jsonl'), JSON.stringify(result) + '\n');
      writeFileSync(path.join(root, `${task.id}-${trial}-${arm}-${orchestration}.json`), JSON.stringify(traces, null, 2));
      console.log(JSON.stringify({ task: task.id, trial, arm, orchestration, pass: result.oraclePass, status: state.status, steps: state.step,
        seconds: Math.round(result.elapsedMs / 100) / 10, error }));
    }
  console.log('RESULTS ' + root);
} finally { await browser.close(); server.stop(); site.close(); }
