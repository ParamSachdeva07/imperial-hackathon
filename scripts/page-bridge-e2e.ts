/**
 * Loads the real extension into Playwright's own Chromium (never the user's Chrome or profile),
 * points it at a local fixture page, and drives it through the app's bridge code.
 *
 *   npm run test:extension
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { PageBridgeServer } from '../apps/desktop/electron/page/page-bridge-server';
import { PageWorkspace } from '../apps/desktop/electron/page/page-workspace';
import { ObservationIndex } from '../apps/desktop/electron/controller/v2/observation-index';

const FIXTURE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Shop - Fixture</title><body>
<header><nav aria-label="Main"><a href="#home">Home</a> <a href="#deals">Deals</a></nav></header>
<main>
  <h1>Find a product</h1><video aria-label="Preview playback" width="300" height="150"></video>
  <form id="search" aria-label="Product search">
    <label for="q">Search products</label> <input id="q" name="q" type="search" placeholder="Search">
    <button type="submit">Search</button>
    <label><input type="checkbox" id="stock"> In stock only</label>
    <select id="sort" aria-label="Sort by"><option>Relevance</option><option>Price: low to high</option></select>
  </form>
  <p id="echo">Nothing typed</p>
  <p id="status">No search yet</p>
  <button id="add" type="button">Add to basket</button> <p id="basket">Basket: 0 items</p>
  <div style="display: contents"><button id="wrapped" type="button">Wrapped button</button></div>
  <label><input type="checkbox" id="slow"> Slow option</label>
  <form id="other"><input id="other-field" aria-label="Other field" type="text"></form> <p id="other-status">Other form untouched</p>
  <div id="editor" contenteditable="true" aria-label="Notes editor">hello world</div>
  <input id="combo" role="combobox" aria-label="Site search" aria-expanded="false" type="text"> <p id="combo-echo">Combo empty</p>
  <div role="alert" aria-live="assertive">Free delivery this week</div>
  <ul aria-label="Catalogue">${Array.from({ length: 600 }, (_, i) => `<li><a href="#item-${i}">Catalogue item ${i}</a> <span>£${i + 1}.00</span></li>`).join('')}</ul>
</main>
<script>
  // A controlled input in the style of a framework: state is kept in script and only an input event updates it.
  let typed = '', basket = 0;
  const q = document.getElementById('q');
  q.addEventListener('input', () => { typed = q.value; document.getElementById('echo').textContent = 'Typed: ' + typed; });
  document.getElementById('search').addEventListener('submit', event => { event.preventDefault();
    document.getElementById('status').textContent = 'Results for ' + typed + (document.getElementById('stock').checked ? ' (in stock)' : '') + ', sorted by ' + document.getElementById('sort').value;
    document.title = typed + ' - Shop'; });
  document.getElementById('combo').addEventListener('input', event => { document.getElementById('combo-echo').textContent = 'Combo: ' + event.target.value; });
  document.getElementById('other').addEventListener('submit', event => { event.preventDefault(); document.getElementById('other-status').textContent = 'Other form submitted'; });
  // A control that confirms its new state a moment after the click, as many pages do.
  const slow = document.getElementById('slow');
  slow.addEventListener('click', event => { event.preventDefault(); setTimeout(() => { slow.checked = true; }, 250); });
  document.getElementById('add').addEventListener('click', () => { basket++; document.getElementById('basket').textContent = 'Basket: ' + basket + ' items'; });
</script></body></html>`;

const site = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(request.url === '/second' ? '<!doctype html><title>Second page</title><h1>Second page</h1><button>Add to basket</button>'
    : request.url === '/long' ? '<!doctype html><title>Long page</title><ul>' + Array.from({ length: 3000 }, (_, i) => `<li><a href="#r${i}">Row ${i}</a> <span>note ${i}</span></li>`).join('') + '</ul><button>Deep target</button>'
    : FIXTURE);
});
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + (site.address() as { port: number }).port;
// The app normally owns port 8767. So that this test can run while the app is open, it uses a
// copy of the extension pointed at another port; everything else in the copy is identical.
const TEST_PORT = 8768;
const bridge = new PageBridgeServer(TEST_PORT);
assert.equal(await bridge.start(), true, 'Port ' + TEST_PORT + ' is in use.');
const extension = mkdtempSync(path.join(os.tmpdir(), 'page-bridge-ext-'));
cpSync(path.resolve('extension/page-bridge'), extension, { recursive: true });
const worker = path.join(extension, 'background.js');
writeFileSync(worker, readFileSync(worker, 'utf8').replace('127.0.0.1:8767', '127.0.0.1:' + TEST_PORT));
// Branded Chrome no longer accepts --load-extension, so this needs a Chromium build. Playwright's
// own is used when it matches this Playwright version; otherwise name one with PAGE_BRIDGE_CHROMIUM.
const executablePath = process.env.PAGE_BRIDGE_CHROMIUM || undefined;
const context = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'page-bridge-')), {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true,
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results: Record<string, unknown> = {};
try {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(base + '/');
  await page.bringToFront();
  const waitUntil = Date.now() + 40_000;
  while (!bridge.connected && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(bridge.connected, true, 'The extension did not connect to the bridge.');
  const workspace = new PageWorkspace(bridge);
  const signal = new AbortController().signal;

  // Reading: the whole page, 600 catalogue rows included.
  const reads: number[] = [];
  let observation = await workspace.observe('Google Chrome', []);
  for (let i = 0; i < 15; i++) { const t = performance.now(); observation = await workspace.observe('Google Chrome', []); reads.push(performance.now() - t); }
  const snapshot = () => observation.snapshots[0];
  results.elements = snapshot().elements.length;
  const media = snapshot().elements.find(e => e.role === 'video');
  assert.ok(media?.states.includes('paused'), 'media exposes its actual paused state');
  assert.equal(media?.value, '0', 'media exposes numeric playback position');
  results.notices = observation.notices.filter(n => /very large|frame/.test(n));
  results.readMedianMs = Math.round(median(reads) * 10) / 10;
  results.readMaxMs = Math.round(Math.max(...reads) * 10) / 10;
  const index = new ObservationIndex(observation);
  const found = index.select({ query: 'catalogue item 599', requirementTerms: [], pinned: [] }).elements.find(e => e.label === 'Catalogue item 599');
  assert.deepEqual(found?.operations, ['CLICK', 'FOCUS', 'SCROLL_TO'], 'the last row of a 600-row list is retrievable');
  assert.ok(snapshot().elements.some(e => e.role === 'statictext' && e.name === 'Free delivery this week'), 'an announcement is content, not a blocker');

  const element = (name: string) => { const named = snapshot().elements.filter(x => x.name === name);
    const e = named.find(x => x.actions.length) || named[0]; assert.ok(e, 'missing ' + name); return e!; };
  const act = async (operation: any, name: string, text?: string, extra: Record<string, unknown> = {}) => {
    const target = element(name);
    const t = performance.now();
    await workspace.act({ id: 'x', operation, description: '', name, app: 'Google Chrome', snapshotId: snapshot().id, targetRef: target.ref, ...extra } as any, observation, text, signal);
    const ms = performance.now() - t;
    observation = await workspace.observe('Google Chrome', []);
    return ms;
  };
  const timings: Record<string, number> = {};
  // Typing must reach the page's own script, not only change what the field shows.
  timings.setValue = await act('SET_VALUE', 'Search products', 'standing desk');
  assert.equal(workspace.takeActionReport()?.verification, 'verified', 'the field was read back after typing');
  assert.equal(await page.evaluate(() => (document.getElementById('echo') as HTMLElement).textContent), 'Typed: standing desk');
  timings.check = await act('CHECK', 'In stock only');
  assert.equal(await page.evaluate(() => (document.getElementById('stock') as HTMLInputElement).checked), true);
  timings.select = await act('SELECT', 'Sort by', 'Price: low to high');
  timings.click = await act('CLICK', 'Add to basket');
  assert.equal(await page.evaluate(() => (document.getElementById('basket') as HTMLElement).textContent), 'Basket: 1 items');
  // Return in the search field submits the form, which is what a person's Return does.
  // Return goes to the field that has focus, so the field is focused first.
  timings.focus = await act('FOCUS', 'Search products');
  timings.pressReturn = await act('PRESS', 'Search products', undefined, { key: 'return' });
  assert.equal(await page.evaluate(() => (document.getElementById('status') as HTMLElement).textContent), 'Results for standing desk (in stock), sorted by Price: low to high');
  assert.equal(snapshot().windowTitle, 'standing desk - Shop', 'the next read shows the new page title');
  assert.ok(snapshot().elements.some(e => e.name.startsWith('Results for standing desk')), 'the result text is readable evidence');
  results.actionMs = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10]));

  // TYPE must verify the resulting field, including replacement of an existing selection.
  await act('SET_VALUE', 'Other field', 'abcd');
  await page.evaluate(() => (document.getElementById('other-field') as HTMLInputElement).setSelectionRange(1, 3));
  await act('TYPE', 'Other field', 'XY');
  assert.equal(await page.evaluate(() => (document.getElementById('other-field') as HTMLInputElement).value), 'aXYd');
  assert.deepEqual([workspace.takeActionReport()?.verification], ['verified']);
  // A synchronous page handler that changes the value is not accepted as an exact write.
  await page.evaluate(() => document.getElementById('other-field')!.addEventListener('input', event => {
    (event.target as HTMLInputElement).value = 'changed by the page';
  }, { once: true }));
  await act('TYPE', 'Other field', 'tail');
  assert.equal(workspace.takeActionReport()?.verification, 'unverified');

  // A wrapper with no box of its own does not hide the button inside it.
  timings.wrapped = await act('CLICK', 'Wrapped button');
  // A click whose effect shows up later was still sent: delivered, not yet confirmed.
  await act('CHECK', 'Slow option');
  assert.deepEqual([workspace.takeActionReport()?.delivery, workspace.takeActionReport()?.verification].slice(0, 1), ['delivered']);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await page.evaluate(() => (document.getElementById('slow') as HTMLInputElement).checked), true, 'the slow checkbox was clicked exactly once');
  // Return is tied to its field. Focus moves to another form; the page refuses and that form is not submitted.
  observation = await workspace.observe('Google Chrome', []);
  const intended = element('Search products');
  await page.evaluate(() => (document.getElementById('other-field') as HTMLElement).focus());
  await assert.rejects(workspace.act({ id: 'x', operation: 'PRESS', description: '', name: 'Search products', app: 'Google Chrome',
    snapshotId: snapshot().id, targetRef: intended.ref, key: 'return' } as any, observation, undefined, signal), /focus is no longer/);
  assert.equal(await page.evaluate(() => (document.getElementById('other-status') as HTMLElement).textContent), 'Other form untouched');
  // Typing into rich text goes where the caret is, not to the end.
  await page.evaluate(() => { const node = document.getElementById('editor')!.firstChild!; const range = document.createRange();
    range.setStart(node, 6); range.collapse(true); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  observation = await workspace.observe('Google Chrome', []);
  await act('TYPE', 'Notes editor', 'big ');
  assert.equal(await page.evaluate(() => (document.getElementById('editor') as HTMLElement).innerText), 'hello big world');

  // A text input that announces itself as a combobox, as YouTube's search box does, still takes text.
  observation = await workspace.observe('Google Chrome', []);
  assert.deepEqual(new ObservationIndex(observation).select({ query: 'site search', requirementTerms: [], pinned: [] })
    .elements.find(e => e.label === 'Site search')?.operations, ['CLICK', 'FOCUS', 'SET_VALUE', 'TYPE', 'SCROLL_TO']);
  await act('SET_VALUE', 'Site search', 'ishowspeed');
  assert.equal(await page.evaluate(() => (document.getElementById('combo-echo') as HTMLElement).textContent), 'Combo: ishowspeed');

  // A stale element is refused, not guessed at.
  const stale = { ...observation, snapshots: [{ ...snapshot(), elements: [{ ...element('Add to basket'), nativeId: '999999', ref: '@' + snapshot().id + ':e999999' }] }] };
  await assert.rejects(workspace.act({ id: 'x', operation: 'CLICK', description: '', name: 'gone', app: 'Google Chrome', snapshotId: snapshot().id,
    targetRef: '@' + snapshot().id + ':e999999' } as any, stale, undefined, signal), /no longer on the page/);

  const previousObservation = observation, previousSnapshot = snapshot(), previousButton = element('Add to basket');
  // Opening an address is one call, with no address bar and no Return key.
  const opened = performance.now();
  await workspace.openUrl(base + '/second', 'Google Chrome', signal);
  results.openUrlMs = Math.round(performance.now() - opened);
  observation = await workspace.observe('Google Chrome', []);
  assert.equal(snapshot().windowTitle, 'Second page');

  // The same-looking button on the new page is a different control, and an action aimed at the
  // old page is refused instead of landing on it.
  const newButton = snapshot().elements.find(e => e.name === 'Add to basket')!;
  assert.notEqual(newButton.nativeId, previousButton.nativeId);
  await assert.rejects(workspace.act({ id: 'x', operation: 'CLICK', description: '', name: 'Add to basket', app: 'Google Chrome',
    snapshotId: previousSnapshot.id, targetRef: previousButton.ref } as any, previousObservation, undefined, signal), /active tab changed/);

  // A page far over the size limit: the control at the very end is still found by searching for it.
  await page.goto(base + '/long');
  await page.bringToFront();
  observation = await workspace.observe('Google Chrome', []);
  assert.ok(!snapshot().elements.some(e => e.name === 'Deep target'), 'beyond the limit it is not listed wholesale');
  assert.ok(observation.notices.some(n => n.includes('very large')));
  const searched = performance.now();
  observation = await workspace.observe('Google Chrome', [], undefined, 'deep target');
  results.longPageReadMs = Math.round(performance.now() - searched);
  results.longPageElements = snapshot().elements.length;
  assert.deepEqual(snapshot().elements.find(e => e.name === 'Deep target')?.actions.includes('Click'), true, 'a search reaches past the limit');

  // The first tab has since loaded another document. Element numbers there start again from 1,
  // so an action read from the old document is refused by the page itself.
  await assert.rejects(workspace.act({ id: 'x', operation: 'CLICK', description: '', name: 'Add to basket', app: 'Google Chrome',
    snapshotId: previousSnapshot.id, targetRef: previousButton.ref } as any, previousObservation, undefined, signal), /page has changed since it was read/);

  // A page the extension may not read is reported, so the caller can fall back to accessibility.
  const internal = await context.newPage();
  await internal.goto('chrome://version/');
  await internal.bringToFront();
  await assert.rejects(workspace.observe('Google Chrome', []), /cannot be read|Cannot access/i);
  console.log('PASS ' + JSON.stringify(results, null, 2));
} finally {
  await context.close();
  bridge.stop();
  site.close();
}
