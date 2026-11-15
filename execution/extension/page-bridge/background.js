// Connects this browser to the Desktop Assistant app on this Mac, and to nothing else.
// It asks the app for one command at a time, runs it in the active tab, and returns the result.
const BASE = 'http://127.0.0.1:8767';
let running = false;

async function post(path, body, timeoutMs) {
  const response = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('bridge ' + response.status);
  return response.json();
}

async function activeTab() {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (focused) return focused;
  const [any] = await chrome.tabs.query({ active: true, windowType: 'normal' });
  if (!any) throw new Error('No browser tab is open.');
  return any;
}
const readable = url => /^(https?|file):/i.test(url || '');
const describeTab = tab => ({ id: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '', status: tab.status, active: tab.active });

async function inPage(tabId, method, args) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const [frame] = await chrome.scripting.executeScript({ target: { tabId },
    func: (name, parameters) => window.__assistantPage[name](...parameters), args: [method, args] });
  return frame?.result;
}
function loaded(tabId, timeoutMs) {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); chrome.tabs.get(tabId).then(resolve, () => resolve(undefined)); };
    const listener = (id, change) => { if (id === tabId && change.status === 'complete') finish(); };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete' && readable(tab.url)) finish(); }, finish);
  });
}

async function handle(command) {
  if (command.type === 'snapshot') {
    const tab = await activeTab();
    const tabs = (await chrome.tabs.query({ windowId: tab.windowId })).slice(0, 40).map(describeTab);
    if (!readable(tab.url)) return { tab: describeTab(tab), tabs, restricted: true };
    try { return { tab: describeTab(tab), tabs, page: await inPage(tab.id, 'snapshot', [command.query || '']) }; }
    catch (error) { return { tab: describeTab(tab), tabs, restricted: true, reason: String(error?.message || error) }; }
  }
  if (command.type === 'act') {
    const tab = await activeTab();
    if (command.tabId && tab.id !== command.tabId) throw new Error('The active tab changed since the page was read.');
    // `command.id` names the command itself; the element on the page is `command.element`.
    return inPage(tab.id, 'act', [command.element, command.operation, command.argument,
      { document: command.document, requireFocus: command.requireFocus === true }]);
  }
  if (command.type === 'open_url') {
    if (!/^https?:\/\//i.test(command.url)) throw new Error('Only http and https addresses can be opened.');
    const current = await activeTab().catch(() => undefined);
    const tab = command.newTab === false && current ? await chrome.tabs.update(current.id, { url: command.url })
      : await chrome.tabs.create({ url: command.url, active: true, windowId: current?.windowId });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { tab: describeTab((await loaded(tab.id, command.waitMs || 6000)) || tab) };
  }
  if (command.type === 'search') {
    // The browser's own default search engine: no results address is ever built here.
    const before = new Set((await chrome.tabs.query({})).map(tab => tab.id));
    await chrome.search.query({ text: String(command.text || ''), disposition: 'NEW_TAB' });
    const opened = (await chrome.tabs.query({})).filter(tab => !before.has(tab.id));
    const tab = opened.find(tab => tab.active) || opened[0] || await activeTab();
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { tab: describeTab((await loaded(tab.id, command.waitMs || 6000)) || tab) };
  }
  if (command.type === 'activate_tab') {
    const tab = await chrome.tabs.update(command.tabId, { active: true });
    return { tab: describeTab(tab) };
  }
  throw new Error('Unknown command ' + command.type);
}

async function loop() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      let command;
      // The app holds this request open until it has something to ask, for at most 20 seconds.
      try { command = await post('/bridge/poll', { version: chrome.runtime.getManifest().version }, 25000); }
      catch { break; } // The app is not running. The alarm below tries again.
      if (!command || !command.id) continue;
      let result;
      try { result = { ok: true, data: await handle(command) }; }
      catch (error) { result = { ok: false, error: String(error?.message || error) }; }
      try { await post('/bridge/result', { id: command.id, ...result }, 5000); } catch { break; }
    }
  } finally { running = false; }
}

chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => loop());
chrome.runtime.onStartup.addListener(() => loop());
chrome.runtime.onInstalled.addListener(() => loop());
chrome.action.onClicked.addListener(() => loop());
chrome.tabs.onActivated.addListener(() => loop());
loop();
