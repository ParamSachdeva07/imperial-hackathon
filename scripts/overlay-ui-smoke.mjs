import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { smokeSession } from './lib/smoke-session.mjs';

// Exercise the real overlay and task lifecycle with the deterministic TextEdit
// fixture. This isolates window/focus behavior from model variability.
const session = await smokeSession('local');
const { application, page } = session;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.getByRole('heading', { name: 'Desktop Assistant' }).waitFor();
  const flags = await application.evaluate(({ BrowserWindow, globalShortcut }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      alwaysOnTop: window.isAlwaysOnTop(),
      allWorkspaces: window.isVisibleOnAllWorkspaces(),
      showShortcut: globalShortcut.isRegistered('CommandOrControl+Shift+Space'),
    };
  });
  assert.deepEqual(flags, { alwaysOnTop: true, allWorkspaces: true, showShortcut: true });
  for (const width of [380, 340]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 190), width);
    await page.getByRole('button', { name: 'Show log' }).waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => document.querySelector('.assistant').scrollHeight <= innerHeight), true);
    await page.screenshot({ path: `.runtime/overlay-compact-${width}.png` });
    await page.getByRole('button', { name: 'Show log' }).click();
    await page.waitForFunction(() => innerHeight >= 400);
    assert.equal(await page.getByRole('heading', { name: 'Live log' }).isVisible(), true);
    await page.screenshot({ path: `.runtime/overlay-expanded-${width}.png` });
    await page.getByRole('button', { name: 'Hide log' }).click();
    await page.waitForFunction(() => innerHeight === 190);
  }
  const taskIds = [];
  for (const text of ['Overlay test one', 'Overlay test two']) {
    const input = page.getByRole('textbox', { name: 'What would you like to do?' });
    await input.fill(`Create a fresh TextEdit document containing ${text}`);
    const accepted = await page.evaluate(text => window.desktop.start({
      goal: `Create a fresh TextEdit document containing ${text}`,
      mode: 'textedit', provider: 'local', text,
    }, false), text);
    assert.equal(accepted.ok, true);
    let state;
    const deadline = Date.now() + 60_000;
    do {
      state = (await page.evaluate(() => window.desktop.state())).data;
      if (!state.busy && ['completed', 'failed', 'blocked', 'cancelled'].includes(state.status)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    writeFileSync('.runtime/overlay-task-state.json', JSON.stringify(state, null, 2));
    assert.equal(state.status, 'completed', state.events.at(-1)?.message);
    assert.equal(state.verifiedText, text);
    taskIds.push(state.taskId);
    assert.equal(await input.isEnabled(), true, 'The next instruction must be editable after completion');
    const after = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { focused: window.isFocused(), visible: window.isVisible(), alwaysOnTop: window.isAlwaysOnTop() };
    });
    assert.deepEqual(after, { focused: false, visible: true, alwaysOnTop: true }, 'Completion must not steal native app focus');
  }
  assert.notEqual(taskIds[0], taskIds[1]);
  assert.deepEqual(errors, []);
  writeFileSync('.runtime/overlay-ui-smoke.json', JSON.stringify({ flags, taskIds, errors, success: true }, null, 2));
  console.log('PASS: overlay layout, collapse/expand, two consecutive native tasks, and no focus theft on completion.');
} finally {
  await session.close();
}
