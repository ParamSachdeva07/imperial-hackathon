// Local control API so another local app (Pointy) can read and move the overlay.
// Deliberately free of any `electron` import so it can be tested in plain node.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Rect = { x: number; y: number; width: number; height: number };
export type ControlState = { expanded: boolean; dragging: boolean; bounds: Rect; workArea: Rect; displayId: string };
export type ControlOptions = {
  getState(): ControlState | null;
  moveTo(x: number, y: number): Rect | null;
  port?: number;
  filePath?: string;
};
export type ControlServer = { close(): Promise<void>; port: number };

const DEFAULT_PORT = 47630;
const BODY_LIMIT = 4096;

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function tokenMatches(given: unknown, token: string) {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // Oversized bodies are discarded (not buffered) so the 400 can still be delivered.
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > BODY_LIMIT ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

const validCoord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100000;

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve((server.address() as { port: number }).port);
    });
  });
}

export async function startControlServer(opts: ControlOptions): Promise<ControlServer> {
  const token = crypto.randomBytes(24).toString('hex');
  const envPort = process.env.ANAM_CONTROL_PORT === undefined || process.env.ANAM_CONTROL_PORT === ''
    ? NaN : Number(process.env.ANAM_CONTROL_PORT);
  const wanted = opts.port ?? (Number.isInteger(envPort) && envPort >= 0 && envPort < 65536 ? envPort : DEFAULT_PORT);
  let port = 0;

  const server = http.createServer(async (req, res) => {
    try {
      if (!tokenMatches(req.headers['x-anam-control-token'], token)) {
        return send(res, 401, { ok: false, reason: 'unauthorized' });
      }
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return send(res, 403, { ok: false, reason: 'forbidden_host' });
      }
      if (req.headers.origin !== undefined) return send(res, 403, { ok: false, reason: 'forbidden_origin' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/state') {
        const state = opts.getState();
        return state ? send(res, 200, { ok: true, state }) : send(res, 503, { ok: false, reason: 'no_window' });
      }
      if (req.method === 'POST' && url.pathname === '/move') {
        const raw = await readBody(req);
        let body: unknown = null;
        try { body = raw === null ? null : JSON.parse(raw); } catch { body = null; }
        const { x, y } = (body && typeof body === 'object' ? body : {}) as { x?: unknown; y?: unknown };
        if (!validCoord(x) || !validCoord(y)) return send(res, 400, { ok: false, reason: 'invalid_input' });
        const state = opts.getState();
        if (!state) return send(res, 503, { ok: false, reason: 'no_window' });
        if (!state.expanded) return send(res, 409, { ok: false, reason: 'collapsed' });
        if (state.dragging) return send(res, 409, { ok: false, reason: 'dragging' });
        const bounds = opts.moveTo(x, y);
        return bounds ? send(res, 200, { ok: true, bounds }) : send(res, 503, { ok: false, reason: 'no_window' });
      }
      return send(res, 404, { ok: false, reason: 'not_found' });
    } catch {
      if (!res.headersSent) send(res, 500, { ok: false, reason: 'internal_error' });
      else res.end();
    }
  });

  try { port = await listen(server, wanted); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || wanted === 0) throw error;
    port = await listen(server, 0);
  }

  const filePath = opts.filePath ?? process.env.ANAM_CONTROL_FILE
    ?? path.join(os.homedir(), '.pointy', 'anam-control.json');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  } catch (error) {
    server.close();
    throw error;
  }

  return {
    port,
    async close() {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      try {
        const current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { token?: unknown; pid?: unknown };
        if (current.token === token && current.pid === process.pid) fs.unlinkSync(filePath);
      } catch { /* already gone or replaced */ }
    },
  };
}
