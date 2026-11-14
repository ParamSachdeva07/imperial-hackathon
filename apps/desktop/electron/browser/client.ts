import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface BrowserClient {
  run(command: string[], signal?: AbortSignal): Promise<any>;
}

export function browserResult(parsed: any): any {
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!envelope?.success)
    throw new Error(typeof envelope?.error === 'string' ? envelope.error : JSON.stringify(envelope?.error || parsed));
  return Array.isArray(parsed) ? envelope.result : envelope.data;
}

export function browserBinary(root: string, resources: string): string {
  const name = 'agent-browser-' + process.platform + '-' + process.arch + (process.platform === 'win32' ? '.exe' : '');
  const bundled = path.join(resources, 'browser', name);
  return existsSync(bundled) ? bundled : path.join(root, 'node_modules/agent-browser/bin', name);
}

export class AgentBrowserClient implements BrowserClient {
  readonly session: string;
  constructor(private binary: string, private stateRoot: string, private executable?: string) {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    this.session = 'assistant-' + createHash('sha256').update(stateRoot).digest('hex').slice(0, 12) +
      (process.env.ASSISTANT_BROWSER_OWNED === '1' ? '-owned' : '-chrome');
  }

  run(command: string[], signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const flags = ['--session', this.session, '--json', '--pin-tab'];
    if (process.env.ASSISTANT_BROWSER_CDP) flags.push('--cdp', process.env.ASSISTANT_BROWSER_CDP);
    else if (process.env.ASSISTANT_BROWSER_OWNED === '1') {
      flags.push('--headed', '--profile', path.join(this.stateRoot, 'profile'));
      if (this.executable) flags.push('--executable-path', this.executable);
    } else flags.push('--auto-connect');
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: '10000' };
    delete env.TYPESAFE_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.CEREBRAS_API_KEY;
    delete env.DECISION_API_TOKEN;
    return new Promise((resolve, reject) => {
      // Literal JSON over stdin keeps text out of shell expansion and process arguments.
      const child = spawn(this.binary, [...flags, 'batch', '--bail', '--omit-command'], {
        shell: false, stdio: ['pipe', 'pipe', 'pipe'], env,
      });
      let stdout = '', stderr = '', finished = false;
      const finish = (error?: Error, value?: any) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => { child.kill('SIGTERM'); finish(new DOMException('Cancelled', 'AbortError')); };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('Browser command timed out; delivery is uncertain. Observe before any retry.'));
      }, 30_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', (error) => finish(error));
      child.stdout.on('data', (data) => {
        stdout += data;
        if (stdout.length > 4 * 1024 * 1024) { child.kill('SIGTERM'); finish(new Error('Browser output exceeded its limit.')); }
      });
      child.stderr.on('data', (data) => { if (stderr.length < 2000) stderr += data; });
      child.on('close', () => {
        if (finished) return;
        try {
          finish(undefined, browserResult(JSON.parse(stdout)));
        } catch (error) { finish(new Error('agent-browser: ' + (error as Error).message + (stdout ? '' : stderr))); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify([command]));
    });
  }
}
