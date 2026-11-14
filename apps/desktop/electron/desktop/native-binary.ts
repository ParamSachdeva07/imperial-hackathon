import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveNativeBinary(root: string, resourcesPath?: string): string {
  if (process.env.AGENT_DESKTOP_BINARY) return process.env.AGENT_DESKTOP_BINARY;
  const name = process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop';
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'native', name);
    if (existsSync(packaged)) return packaged;
  }
  // macOS requires our pinned accessibility fix; never silently use the stock binary.
  if (process.platform === 'darwin') return path.join(root, '.runtime', 'native', name);
  return path.join(root, 'node_modules', 'agent-desktop', 'bin', name);
}
