// The execution agent without a window: the broker, the desktop and page adapters, and a local
// service another program calls. See apps/desktop/electron/service.ts for the calls.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { NavigationController } from '../apps/desktop/electron/controller/navigation';
import { defaultBrowserBundle } from '../apps/desktop/electron/desktop/app-discovery';
import { resolveNativeBinary } from '../apps/desktop/electron/desktop/native-binary';
import { WorkspaceDesktopBridge } from '../apps/desktop/electron/desktop/workspace';
import { PageAwareBridge } from '../apps/desktop/electron/page/page-aware-bridge';
import { PageBridgeServer } from '../apps/desktop/electron/page/page-bridge-server';
import { PageWorkspace } from '../apps/desktop/electron/page/page-workspace';
import { DecisionClient } from '../apps/desktop/electron/services/decision-client';
import { ExecutionService, SERVICE_FILE } from '../apps/desktop/electron/service';

const root = path.resolve(import.meta.dirname, '..');
const data = process.env.EXECUTION_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Desktop Assistant Lab');
const freePort = () => new Promise<number>(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); }); });

const token = randomBytes(32).toString('hex'), brokerPort = await freePort();
const uv = process.env.UV_BINARY || path.join(os.homedir(), '.local/bin/uv');
const broker = spawn(uv, ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(brokerPort), '--no-access-log'],
  { cwd: path.join(root, 'services/decision-api'), env: { ...process.env, DECISION_API_TOKEN: token }, stdio: 'inherit' });
const api = new DecisionClient('http://127.0.0.1:' + brokerPort, token);
for (let i = 0; i < 120 && !(await api.health()).available; i++) await new Promise(resolve => setTimeout(resolve, 250));

const workspace = new WorkspaceDesktopBridge(resolveNativeBinary(root), path.join(data, 'native-state'));
const pages = new PageBridgeServer();
if (process.env.ASSISTANT_PAGE_BRIDGE !== 'off') await pages.start();
const controller = new NavigationController(new PageAwareBridge(workspace, new PageWorkspace(pages), defaultBrowserBundle), api,
  process.env.ASSISTANT_TRACE_DIR || path.join(data, 'traces'), defaultBrowserBundle);
const service = new ExecutionService(controller);
const { port } = await service.start(Number(process.env.EXECUTION_SERVICE_PORT) || 0);
const native = await workspace.health(), backend = await api.health();
console.log('Execution service on 127.0.0.1:' + port + ' (connection details in ' + SERVICE_FILE + ').');
console.log('Accessibility: ' + native.accessibility + ' | navigator: ' + (backend.navigatorModel || 'not configured') + ' | Luna: ' + (backend.orchestratorModel || 'not configured'));

const shutdown = () => { service.stop(); pages.stop(); broker.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);
process.on('SIGTERM', shutdown);
broker.on('exit', () => { console.error('The broker stopped.'); shutdown(); });
