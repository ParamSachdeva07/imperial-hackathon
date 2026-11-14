import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Application } from '../../../../packages/contracts/src/index';

const exec = promisify(execFile);
export function rankApplicationPaths(paths: string[], query: string): string[] {
  const normalize = (s: string) =>
    s
      .toLocaleLowerCase()
      .replace(/\.app$/i, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
  const target = normalize(query);
  if (!target) return [];
  return [...new Set(paths)]
    .filter((p) => path.isAbsolute(p) && p.endsWith('.app') && !p.includes('\n'))
    .map((p) => ({ path: p, name: normalize(path.basename(p)) }))
    .filter((p) => p.name.includes(target) || (target.includes(p.name) && p.name.length >= 4))
    .sort(
      (a, b) =>
        Number(b.name === target) - Number(a.name === target) ||
        a.name.length - b.name.length ||
        a.path.localeCompare(b.path),
    )
    .slice(0, 20)
    .map((p) => p.path);
}

export async function searchIndexedApplications(query: string, signal?: AbortSignal): Promise<Application[]> {
  signal?.throwIfAborted();
  // The user's words never enter a shell command or Spotlight query language.
  const { stdout } = await exec(
    '/usr/bin/mdfind',
    ['-0', 'kMDItemContentType == "com.apple.application-bundle"'],
    { signal, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const paths = rankApplicationPaths(stdout.split('\0'), query);
  const results = await Promise.all(
    paths.map(async (appPath) => {
      try {
        const { stdout: id } = await exec(
          '/usr/bin/plutil',
          ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist')],
          { signal, timeout: 3000, maxBuffer: 10000 },
        );
        const bundleId = id.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(bundleId)) return;
        return { name: path.basename(appPath, '.app'), id: bundleId, running: false };
      } catch {
        signal?.throwIfAborted();
        return;
      }
    }),
  );
  return [...new Map(results.filter((a): a is Application => !!a).map((a) => [a.id, a])).values()];
}
