import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensurePasteHelper } from './build-paste.mjs';

const revision = 'b0b7277bea09b770ef9d1fb45aad667bc432cd57';
const names = ['agent-desktop', 'agent-desktop-macos-helper'];

export async function ensureNative(root) {
  if (process.platform !== 'darwin') throw new Error('The native build currently supports macOS.');
  const patch = path.join(root, 'native/agent-desktop.patch');
  const fingerprint = createHash('sha256')
    .update(revision + process.arch)
    .update(readFileSync(patch))
    .digest('hex');
  const output = path.join(root, '.runtime/native');
  const stamp = path.join(output, 'build.json');
  if (existsSync(stamp) && names.every((name) => existsSync(path.join(output, name)))) {
    if (JSON.parse(readFileSync(stamp, 'utf8')).fingerprint === fingerprint) {
      await ensurePasteHelper(root, output);
      return output;
    }
  }
  const source = path.join(root, '.runtime/native-source', fingerprint.slice(0, 16));
  const target = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(source, 'target');
  const run = (command, args, cwd = root) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    });
  mkdirSync(path.dirname(source), { recursive: true });
  if (!existsSync(source)) {
    await run('/usr/bin/git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      'v1.3.1',
      'https://github.com/vercel-labs/agent-desktop.git',
      source,
    ]);
  }
  await run('/usr/bin/git', ['checkout', '--detach', revision], source);
  const applied = path.join(source, '.assistant-patch');
  if (!existsSync(applied)) {
    await run('/usr/bin/git', ['apply', '--check', patch], source);
    await run('/usr/bin/git', ['apply', patch], source);
    writeFileSync(applied, fingerprint);
  }
  const cargo =
    process.env.CARGO_BINARY || (existsSync('/opt/homebrew/bin/cargo') ? '/opt/homebrew/bin/cargo' : 'cargo');
  await run(
    cargo,
    ['build', '--release', '--locked', '-p', 'agent-desktop', '-p', 'agent-desktop-macos'],
    source,
  );
  mkdirSync(output, { recursive: true });
  for (const name of names) {
    copyFileSync(path.join(target, 'release', name), path.join(output, name));
    chmodSync(path.join(output, name), 0o755);
  }
  copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE-agent-desktop'));
  writeFileSync(stamp, JSON.stringify({ revision, fingerprint, arch: process.arch }, null, 2));
  await ensurePasteHelper(root, output);
  return output;
}
