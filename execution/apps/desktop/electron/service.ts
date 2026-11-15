import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ControllerState } from '../../../packages/contracts/src/index';
import type { NavigationController } from './controller/navigation';

/** Where a caller on this machine finds the service: `{ port, token, pid }`. */
export const SERVICE_FILE = process.env.EXECUTION_SERVICE_FILE || path.join(os.homedir(), '.execution-agent', 'service.json');

/** What a caller is told about a task. The full event log stays in the trace. */
export type TaskReport = Pick<ControllerState, 'taskId' | 'status' | 'busy' | 'step' | 'plan' | 'completion'> & { goal: string; message: string };
export const report = (state: ControllerState): TaskReport => ({
  taskId: state.taskId, status: state.status, busy: state.busy, step: state.step, plan: state.plan, completion: state.completion,
  goal: state.input?.goal ?? '', message: state.events.at(-1)?.message ?? '',
});

/**
 * The execution agent as a tool for another program on this machine. One task at a time:
 * starting a task while one runs replaces it. Loopback only, and every call carries the token.
 *
 *   POST /task  { goal, context? }  -> { taskId }      start, or replace the running task
 *   POST /stop                      -> report           stop the running task
 *   GET  /state                     -> report
 *   GET  /events                    -> server-sent reports, one per change
 */
export class ExecutionService {
  private server?: http.Server;
  private token = randomBytes(24).toString('hex');
  port = 0;
  constructor(private controller: NavigationController, private file: string | null = SERVICE_FILE) {}

  async start(port = 0): Promise<{ port: number; token: string }> {
    this.server = http.createServer((request, response) => void this.handle(request, response).catch(error => {
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }));
    await new Promise<void>((resolve, reject) => this.server!.once('error', reject).listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify({ port: this.port, token: this.token, pid: process.pid }), { mode: 0o600 });
    }
    return { port: this.port, token: this.token };
  }
  stop() {
    this.controller.cancel();
    this.server?.closeAllConnections();
    this.server?.close();
    if (this.file) rmSync(this.file, { force: true });
  }

  private authorised(request: http.IncomingMessage): boolean {
    const given = Buffer.from((request.headers.authorization || '').replace(/^Bearer /, ''));
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    // A browser page must never be able to drive the desktop: no page sends this token, and none is answered with CORS headers.
    if (!this.authorised(request)) return send(401, { error: 'Invalid token.' });
    const route = request.method + ' ' + (request.url || '').split('?')[0];
    if (route === 'GET /state') return send(200, report(this.controller.state()));
    if (route === 'POST /stop') return send(200, report(this.controller.cancel()));
    if (route === 'POST /task') {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (raw.length > 20_000) throw new Error('Request too large.'); }
      const { goal, context } = JSON.parse(raw || '{}');
      const input = { goal, ...(typeof context === 'string' && context ? { context: context.slice(0, 6000) } : {}) };
      const state = this.controller.state().busy ? await this.controller.replace(input) : this.controller.start(input);
      return send(200, { taskId: state.taskId });
    }
    if (route === 'GET /events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      let last = '';
      const push = (state: ControllerState) => {
        const data = JSON.stringify(report(state));
        if (data !== last) response.write('data: ' + (last = data) + '\n\n');
      };
      push(this.controller.state());
      const unsubscribe = this.controller.subscribe(push);
      request.on('close', unsubscribe);
      return;
    }
    send(404, { error: 'Unknown route.' });
  }
}
