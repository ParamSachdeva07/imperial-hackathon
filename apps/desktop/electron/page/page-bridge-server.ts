import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { PAGE_BRIDGE_EXTENSION_ID, PAGE_BRIDGE_PORT, PAGE_BRIDGE_VERSION } from './extension-id';

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Command = { id: string; type: string; [key: string]: unknown };

export class PageBridgeError extends Error {}

/**
 * The app's side of the browser extension. It listens on loopback only and answers only the
 * pinned extension's origin, which a web page cannot forge. The extension asks for one command
 * at a time (a held request), so a command reaches the page within milliseconds.
 */
export class PageBridgeServer {
  private server?: http.Server;
  private queue: Command[] = [];
  private pending = new Map<string, Pending>();
  private waiting?: { response: http.ServerResponse; timer: NodeJS.Timeout };
  private lastPoll = 0;
  /** The version the extension reported when it last asked for work. */
  version = '';
  port = 0;

  constructor(private requestedPort = PAGE_BRIDGE_PORT,
    private origin = 'chrome-extension://' + PAGE_BRIDGE_EXTENSION_ID, private holdMs = 20_000,
    private expectedVersion = PAGE_BRIDGE_VERSION) {}

  /** Resolves false when the port is taken; the app then simply runs without the page bridge. */
  start(): Promise<boolean> {
    return new Promise(resolve => {
      const server = http.createServer((request, response) => void this.handle(request, response));
      server.once('error', () => resolve(false));
      server.listen(this.requestedPort, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        resolve(true);
      });
    });
  }
  stop() {
    this.release({});
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new PageBridgeError('The page bridge stopped.')); }
    this.pending.clear();
    this.server?.close();
    this.server = undefined;
  }
  /** The extension has asked for work recently, so a command will be picked up at once. */
  get reachable(): boolean {
    return !!this.server && (!!this.waiting || Date.now() - this.lastPoll < this.holdMs + 10_000);
  }
  /**
   * Reachable and speaking this app's version. Chrome keeps running the old copy of an unpacked
   * extension until it is reloaded, and an old copy's answers would be misread.
   */
  get connected(): boolean { return this.reachable && this.version === this.expectedVersion; }
  get needsReload(): boolean { return this.reachable && this.version !== this.expectedVersion; }

  private release(body: unknown) {
    if (!this.waiting) return;
    clearTimeout(this.waiting.timer);
    this.waiting.response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    this.waiting = undefined;
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const reply = (status: number, body: unknown) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (request.method !== 'POST' || request.headers.origin !== this.origin) return reply(403, { error: 'forbidden' });
    let body: any;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) return reply(413, { error: 'too large' });
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch { return reply(400, { error: 'invalid body' }); }
    if (request.url === '/bridge/poll') {
      this.lastPoll = Date.now();
      this.version = typeof body?.version === 'string' ? body.version : '';
      this.release({});
      const next = this.queue.shift();
      if (next) return reply(200, next);
      const timer = setTimeout(() => this.release({}), this.holdMs);
      this.waiting = { response, timer };
      response.on('close', () => { if (this.waiting?.response === response) { clearTimeout(timer); this.waiting = undefined; } });
      return;
    }
    if (request.url === '/bridge/result') {
      const pending = this.pending.get(body?.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(body.id);
        if (body.ok) pending.resolve(body.data); else pending.reject(new PageBridgeError(String(body.error || 'The page could not do that.')));
      }
      return reply(200, {});
    }
    return reply(404, { error: 'not found' });
  }

  send<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 8000, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!this.connected) return Promise.reject(new PageBridgeError('The browser extension is not connected.'));
    if ('id' in payload || 'type' in payload) return Promise.reject(new PageBridgeError('A command payload cannot use the reserved names id or type.'));
    const command: Command = { ...payload, id: randomUUID(), type };
    return new Promise<T>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.pending.delete(command.id); signal?.removeEventListener('abort', abort); };
      const abort = () => { done(); this.queue = this.queue.filter(c => c.id !== command.id); reject(signal!.reason); };
      const timer = setTimeout(() => { done(); this.queue = this.queue.filter(c => c.id !== command.id);
        reject(new PageBridgeError('The browser extension did not answer in time.')); }, timeoutMs);
      this.pending.set(command.id, { resolve: value => { done(); resolve(value); }, reject: error => { done(); reject(error); }, timer });
      signal?.addEventListener('abort', abort, { once: true });
      if (this.waiting) this.release(command); else this.queue.push(command);
    });
  }
}
