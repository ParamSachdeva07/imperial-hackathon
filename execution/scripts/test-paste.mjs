import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
if (process.platform === 'darwin') {
  mkdirSync('.runtime', { recursive: true });
  for (const [command, args] of [
    [
      '/usr/bin/xcrun',
      [
        'swiftc',
        '-DPASTE_TESTS',
        'native/focus-and-paste.swift',
        'tests/native/main.swift',
        '-o',
        '.runtime/paste-native-tests',
      ],
    ],
    ['.runtime/paste-native-tests', []],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error || result.status !== 0)
      throw result.error || new Error(command + ' exited ' + result.status);
  }
}
