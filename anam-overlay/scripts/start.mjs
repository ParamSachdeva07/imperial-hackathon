import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ANAM_API_KEY;
for (const name of ['SYNTHESIA_API_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) delete env[name];
delete env.VITE_ANAM_API_KEY;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
