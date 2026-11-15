import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

export async function ensurePasteHelper(root, output) {
  const source = path.join(root, 'native/focus-and-paste.swift');
  const binary = path.join(output, 'focus-and-paste');
  const stamp = binary + '.sha256';
  const hash = createHash('sha256').update(process.arch).update(readFileSync(source)).digest('hex');
  if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash) return;
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', source, '-o', binary], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Paste helper build failed: ' + code)),
    );
  });
  writeFileSync(stamp, hash);
}
