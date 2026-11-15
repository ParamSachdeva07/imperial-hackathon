/**
 * Replay recorded planner requests against the planning model, without a live desktop.
 *
 *   npm run eval:replay -- --trace .runtime/traces/<taskId>.jsonl [--repeat 3]
 *
 * Use it to compare a prompt, model or retrieval change on the exact observations of an earlier
 * run. It spends model quota and sends the recorded screen text to the configured provider.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const argument = (name: string) => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const source = argument('trace');
assert.ok(source, 'Pass --trace <file or directory>.');
const files = statSync(source).isDirectory() ? readdirSync(source).filter(f => f.endsWith('.jsonl')).map(f => path.join(source, f)) : [source];
const repeat = Number(argument('repeat') || 1);

type Pair = { request: any; step: any };
const pairs: Pair[] = [];
for (const file of files) {
  let pending: any;
  for (const line of readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))) {
    if (line.kind === 'plan_request') pending = line.data;
    if (line.kind === 'plan_step' && pending) { pairs.push({ request: pending, step: line.data.step }); pending = undefined; }
  }
}
assert.ok(pairs.length, 'No planner exchanges were found. Only the v2 controller records them.');
const describe = (request: any, step: any) => step.kind !== 'act' ? step.kind + (step.scope ? ' ' + step.scope : '')
  : step.operation + ' ' + (request.elements.find((e: any) => e.id === step.target)?.label ?? step.key);

const port: number = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const p = (server.address() as net.AddressInfo).port; server.close(() => resolve(p)); });
});
const token = randomBytes(32).toString('hex'), url = 'http://127.0.0.1:' + port;
const uv = process.env.UV_BINARY || path.join(process.env.HOME || '', '.local/bin/uv');
const backend = spawn(uv, ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
  { cwd: path.join(process.cwd(), 'services/decision-api'), env: { ...process.env, DECISION_API_TOKEN: token }, stdio: 'ignore' });
try {
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  for (let i = 0; i < 80; i++) {
    if (await fetch(url + '/health', { headers }).then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  let same = 0, total = 0, failed = 0, ms = 0;
  for (const { request, step } of pairs)
    for (let n = 0; n < repeat; n++) {
      const started = performance.now();
      const response = await fetch(url + '/navigation/plan', { method: 'POST', headers, body: JSON.stringify(request) });
      ms += performance.now() - started;
      total++;
      if (!response.ok) { failed++; console.log('step ' + request.step + ': broker HTTP ' + response.status); continue; }
      const replayed = await response.json();
      const before = describe(request, step), now = describe(request, replayed);
      if (before === now) same++;
      else console.log('step ' + request.step + ': recorded ' + JSON.stringify(before) + ' → replayed ' + JSON.stringify(now));
    }
  console.log(`\n${same}/${total} replayed steps matched the recording; ${failed} failed; mean ${Math.round(ms / total)} ms per call.`);
  console.log('A different step is not necessarily a worse one: read the differences above.');
} finally {
  backend.kill('SIGTERM');
}
