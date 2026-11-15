import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';

// options.validate maps a broker route to a hook that may throw to block the response;
// options.env adds environment variables for the Electron process.
export async function smokeSession(mode = 'jev', validateDecision, options = {}) {
  const hooks = { ...(validateDecision ? { '/navigation/decide': validateDecision } : {}), ...(options.validate || {}) };
  const requests = [];
  const root = process.cwd(),
    require = createRequire(import.meta.url);
  const token = randomBytes(32).toString('hex');
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
  });
  const apiUrl = 'http://127.0.0.1:' + port;
  const uv = process.env.UV_BINARY || path.join(process.env.HOME, '.local/bin/uv');
  const backend = spawn(
    uv,
    ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
    {
      cwd: path.join(root, 'services/decision-api'),
      env: { ...process.env, DECISION_API_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let application, proxy, backendHealth;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        const response = await fetch(apiUrl + '/health', { headers: { Authorization: 'Bearer ' + token } });
        if (response.ok) {
          const health = await response.json();
          backendHealth = health;
          if (mode === 'jev')
            assert.equal(health.keyConfigured, true, 'A TypeSafe key must be configured for a live test.');
          ready = true;
          break;
        }
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(ready, true, 'Decision backend did not become ready.');
    let decisionUrl = apiUrl;
    if (Object.keys(hooks).length) {
      proxy = http.createServer(async (request, response) => {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = Buffer.concat(chunks).toString();
          const timing = { route: request.url, startedAt: Date.now() };
          requests.push(timing);
          const upstream = await fetch(apiUrl + request.url, {
            method: request.method,
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: body || undefined,
          });
          const result = await upstream.json();
          timing.durationMs = Date.now() - timing.startedAt;
          timing.status = upstream.status;
          timing.model = result.model;
          timing.usage = result.usage;
          if (upstream.ok && hooks[request.url]) await hooks[request.url](JSON.parse(body), result);
          const retryable = upstream.headers.get('x-retryable');
          response.writeHead(upstream.status, { 'Content-Type': 'application/json', ...(retryable ? { 'X-Retryable': retryable } : {}) });
          response.end(JSON.stringify(result));
        } catch (error) {
          response.writeHead(409, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ detail: error.message }));
        }
      });
      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      decisionUrl = 'http://127.0.0.1:' + proxy.address().port;
    }
    const env = {
      ...process.env,
      ASSISTANT_ROOT: root,
      DECISION_API_URL: decisionUrl,
      DECISION_API_TOKEN: token,
      ASSISTANT_NATIVE_STATE: path.join(root, '.runtime', 'ui-native-state'),
      ASSISTANT_BROWSER_STATE: path.join(root, '.runtime', 'browser-ui-state'),
      ASSISTANT_TRACE_DIR: path.join(root, '.runtime', 'traces'),
      ...(options.env || {}),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.TYPESAFE_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.CEREBRAS_API_KEY;
    delete env.ASSISTANT_RENDERER_URL;
    application = await _electron.launch({
      executablePath: require('electron'),
      args: [root],
      env,
      timeout: 30_000,
    });
    const page = await application.firstWindow();
    const cancel = () => { void page.evaluate(() => window.desktop.cancel()).catch(() => {}); };
    process.on('SIGUSR1', cancel);
    return {
      requests,
      backendHealth,
      application,
      page,
      close: async () => {
        process.off('SIGUSR1', cancel);
        await application.close();
        backend.kill('SIGTERM');
        proxy?.close();
      },
    };
  } catch (error) {
    await application?.close();
    backend.kill('SIGTERM');
    proxy?.close();
    throw error;
  }
}
