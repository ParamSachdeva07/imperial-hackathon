import { spawn } from 'node:child_process';
import { mkdirSync, chmodSync } from 'node:fs';

type Envelope = {
  ok: boolean;
  data?: any;
  error?: { code?: string; message?: string; disposition?: unknown; details?: Record<string, unknown> };
};
export class NativeError extends Error {
  constructor(
    public code: string,
    message: string,
    public disposition?: unknown,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export class NativeClient {
  constructor(
    readonly binary: string,
    readonly stateRoot: string,
  ) {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(stateRoot, 0o700);
  }

  protected run(args: string[], input?: string, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, AGENT_DESKTOP_HOME: this.stateRoot };
      for (const credential of ['TYPESAFE_API_KEY', 'OPENAI_API_KEY', 'CEREBRAS_API_KEY', 'DECISION_API_TOKEN']) delete env[credential];
      const child = spawn(this.binary, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      let stdout = '',
        stderr = '',
        settled = false;
      const finish = (error?: Error, value?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {
        child.kill('SIGTERM');
        finish(new DOMException('Cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(
          new NativeError(
            'TIMEOUT',
            'Native command timed out. Its delivery may be uncertain; inspect before retrying.',
          ),
        );
      }, 30_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', (error) =>
        finish(new NativeError('BINARY_UNAVAILABLE', 'Cannot run agent-desktop: ' + error.message)),
      );
      child.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > 4 * 1024 * 1024) {
          child.kill('SIGTERM');
          finish(new NativeError('OUTPUT_LIMIT', 'Native snapshot exceeded the size limit.'));
        }
      });
      child.stderr.on('data', (data) => {
        if (stderr.length < 2000) stderr += data.toString();
      });
      child.on('close', (code) => {
        if (settled) return;
        try {
          const result: Envelope = JSON.parse(stdout);
          if (!result.ok)
            finish(
              new NativeError(
                result.error?.code ?? 'NATIVE_ERROR',
                result.error?.message ?? 'Native command failed.',
                result.error?.disposition,
                result.error?.details,
              ),
            );
          else finish(undefined, result.data);
        } catch {
          finish(
            new NativeError(
              'INVALID_OUTPUT',
              'agent-desktop returned invalid JSON (exit ' + code + '). ' + stderr.slice(0, 200),
            ),
          );
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async health() {
    try {
      const data = await this.run(['status']);
      return {
        available: true,
        version: data.version,
        accessibility: data.permissions?.accessibility?.state ?? 'unknown',
      };
    } catch (e) {
      return { available: false, accessibility: 'unknown', message: (e as Error).message };
    }
  }
}
