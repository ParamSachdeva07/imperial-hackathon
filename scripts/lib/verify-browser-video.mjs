import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function verifyBrowserVideo(root, stateRoot) {
  const session = 'assistant-' + createHash('sha256').update(stateRoot).digest('hex').slice(0, 12) +
    (process.env.ASSISTANT_BROWSER_OWNED === '1' ? '-owned' : '-chrome');
  const binary = path.join(root, 'node_modules/agent-browser/bin', 'agent-browser-' + process.platform + '-' + process.arch);
  const script = `(async () => {
    const video = Array.from(document.querySelectorAll('video')).find(v => v.getClientRects().length && !v.paused && !v.ended);
    if (!video) return {playing:false, advanced:false, url:location.href, title:document.title};
    const before = video.currentTime;
    await new Promise(resolve => setTimeout(resolve, 800));
    return {playing:!video.paused && !video.ended, advanced:video.currentTime > before,
      before, after:video.currentTime, url:location.href, title:document.title};
  })()`;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--session', session, '--json', '--pin-tab', 'batch', '--bail', '--omit-command'], {stdio:['pipe','pipe','pipe']});
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Playback verification timed out')); }, 15000);
    child.stdout.on('data', data => output += data);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      try { const row = JSON.parse(output)[0]; if (!row.success) throw new Error(row.error); resolve(row.result.result); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify([['eval', script]]));
  });
}
