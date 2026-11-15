import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer();
await server.listen();
const env = { ...process.env, OVERLAY_DEV: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ANAM_API_KEY;
delete env.VITE_ANAM_API_KEY;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
