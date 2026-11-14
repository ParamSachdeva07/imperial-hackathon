import { verifyRecipient } from './lib/verify-recipient.mjs';
import { smokeSession } from './lib/smoke-session.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyBrowserVideo } from './lib/verify-browser-video.mjs';

const root = process.cwd();
const mode = 'jev';
const scenario = process.env.ASSISTANT_SMOKE_SCENARIO || 'calculator';
const goal =
  process.env.ASSISTANT_SMOKE_GOAL ||
  'In Calculator, clear the current calculation, enter 7 + 5 and press Equals. Finish when the displayed result is 12.';
const session = await smokeSession(
  mode,
  scenario === 'youtube'
    ? (request, decision) => {
        const action = request.candidates.find((candidate) => candidate.id === decision.candidateId);
        if (!action) return;
        const reading = ['BROWSE_TREE', 'BROWSE_APPS', 'READ_SURFACE', 'READ_WINDOW', 'READ_BROWSER', 'INSPECT_REGION', 'WAIT'];
        const safe = reading.includes(action.operation) ||
          (action.operation === 'NAVIGATE' && request.context.driver === 'browser') ||
          (action.operation === 'OPEN_APP' && ['Google Chrome', 'com.google.Chrome'].includes(action.app)) ||
          (['FOCUS_WINDOW', 'FOCUS', 'SCROLL', 'SCROLL_TO'].includes(action.operation) && action.app === 'Google Chrome') ||
          (['SET_VALUE', 'TYPE', 'FOCUS_AND_PASTE'].includes(action.operation) && /^(Address and search bar|Search)$/i.test(action.name)) ||
          (action.operation === 'SET_VALUE' && request.context.driver === 'browser' &&
            ['combobox', 'searchbox', 'textfield'].includes(action.role) &&
            request.observations.some(snapshot => snapshot.text.some(line => /^Browser page URL: https:\/\/www\.youtube\.com\/(?:$|results\?|watch\?)/.test(line)))) ||
          (action.operation === 'PRESS' && ['return', 'escape', 'tab', 'shift+tab', 'cmd+l', 'cmd+t', 'Enter', 'Escape', 'Tab', 'Shift+Tab', 'Space'].includes(action.key)) ||
          (action.operation === 'CLICK' && /rag|retrieval|youtube|^search|^Address and search bar$|^accept|^reject|^play|^pause|^skip ad/i.test(action.name)
            && !/subscribe|like|comment|share|download|save/i.test(action.name));
        assert.ok(safe, 'Video smoke blocked an out-of-scope action: ' + action.operation + ' ' + action.name);
      }
    : scenario === 'recipient'
    ? (request, decision) => {
        const action = request.candidates.find((candidate) => candidate.id === decision.candidateId);
        if (!action) return;
        const navigation = [
          'BROWSE_TREE',
          'BROWSE_APPS',
          'READ_SURFACE',
          'READ_WINDOW',
          'INSPECT_REGION',
          'FOCUS',
          'FOCUS_WINDOW',
          'OPEN_APP',
        ];
        const safe =
          navigation.includes(action.operation) ||
          (['TYPE', 'SET_VALUE'].includes(action.operation) &&
            ['To Recipients', 'Subject'].includes(action.name)) ||
          (action.operation === 'CLICK' && action.name === 'Use this address: zcabps0@ucl.ac.uk') ||
          (action.operation === 'PRESS' && ['return', 'tab', 'escape'].includes(action.key));
        assert.ok(
          safe,
          'Recipient smoke test blocked an out-of-scope action: ' + action.operation + ' ' + action.name,
        );
      }
    : undefined,
);
const { application, page } = session;
try {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.getByRole('heading', { name: 'Desktop Assistant' }).waitFor();
  await page.waitForFunction(
    async () => {
      const result = await window.desktop.health();
      return result.ok && result.data.native.accessibility === 'granted';
    },
    null,
    { timeout: 10_000 },
  );
  assert.equal(await page.getByRole('spinbutton').count(), 0, 'Confidence settings must be removed');
  await page.getByLabel('What would you like to do?').fill(goal);
  await page.getByRole('button', { name: 'Send instruction', exact: true }).click();
  let state;
  const observedUrls = new Set();
  const deadline = Date.now() + 600_000;
  let lastEvent = 0;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.desktop.state());
    assert.equal(result.ok, true);
    state = result.data;
    if (state.snapshot?.browser?.url) observedUrls.add(state.snapshot.browser.url);
    for (const event of state.events.filter((e) => e.id > lastEvent)) {
      if (['observation', 'decision', 'result', 'error'].includes(event.type))
        console.log(event.type + ': ' + event.message);
      lastEvent = event.id;
    }
    if (state.taskId && !state.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  writeFileSync(path.join(root, '.runtime', 'desktop-last-state.json'), JSON.stringify(state, null, 2));
  console.log(
    JSON.stringify(
      {
        provider: mode,
        status: state?.status,
        model: state?.decision?.model,
        confidence: state?.decision?.confidence,
        completionConfidence: state?.decision?.goalConfidence,
        steps: state?.step,
        events: state?.events.slice(-12).map((e) => e.message),
      },
      null,
      2,
    ),
  );
  const recipientVerification = scenario === 'recipient' ? await verifyRecipient(root, state) : undefined;
  if (!recipientVerification) {
    assert.equal(state?.status, 'completed', 'UI task must complete with verified text.');
    assert.equal(state?.completion?.kind, 'model-assessed');
  }
  if (scenario === 'cross-app') {
    assert.equal(state.observation?.context.app, 'Calculator');
    assert.ok(state.completion.evidence.some((line) => line.includes('Hierarchy bridge ready')));
    assert.ok(state.events.some((event) => event.message.includes('SET_VALUE')));
  }
  if (scenario === 'youtube') {
    assert.ok([...observedUrls].some(url => /youtube\.com\/results\?/.test(url) && new URL(url).searchParams.get('search_query') === 'rag'), 'Must observe submitted YouTube results for rag');
    assert.ok(/youtube\.com\/watch\?/.test(state.snapshot?.browser?.url || ''), 'Must observe a YouTube watch URL');
    const playback = await verifyBrowserVideo(root, path.join(root, '.runtime', 'browser-ui-state'));
    assert.ok(playback.playing && playback.advanced, 'Independent media read must show playback time advancing');
    assert.ok(/rag|retrieval/i.test(playback.title), 'The playing video must relate to rag');
    writeFileSync(path.join(root, '.runtime', 'youtube-playback-evidence.json'), JSON.stringify({ observedUrls: [...observedUrls], playback }, null, 2));
  }
  if (scenario === 'search') {
    const elements = state.snapshot?.elements || [];
    assert.ok(
      elements.some((e) => /youtube\.com\/results\?/.test(e.value)),
      'Must observe a YouTube search results URL',
    );
    assert.ok(
      elements.some((e) => e.value === '3d printer'),
      'The search box must contain the unquoted requested query',
    );
    assert.ok(
      state.events.some((e) => e.message.includes('Understood "3d printer"')),
      'Text must be resolved from normal instructions',
    );
  }
  if (scenario === 'app-search') {
    assert.ok(
      state.events.some((e) => e.message.startsWith('SEARCH_APPS')),
      'Must use application discovery',
    );
    assert.equal(state.observation?.context.app, 'Directory Utility');
  }
  if (scenario === 'instruction-text') {
    assert.ok(
      state.snapshot?.elements.some((e) => e.value.trim() === 'hello Alex'),
      'Document must contain the text extracted from the unquoted instruction',
    );
    assert.ok(
      state.events.some((e) => e.message.includes('Understood "hello Alex"')),
      'Must interpret the instruction',
    );
  }
  if (scenario === 'calculator')
    assert.ok(
      state.snapshot?.text?.some((line) => /statictext.*12/.test(line)),
      'Calculator result must be read as 12 from AX',
    );
  assert.equal(state?.decision?.provider, mode);
  assert.deepEqual(browserErrors, []);
  const screenshot = path.join(root, '.runtime', 'desktop-navigation-' + scenario + '.png');
  await page.screenshot({ path: screenshot });
  const report = {
    testedAt: new Date().toISOString(),
    provider: mode,
    model: state.decision.model,
    confidence: state.decision.confidence,
    status: state.status,
    verifiedText: state.verifiedText,
    steps: state.step,
    app: state.observation?.context.app,
    windowId: state.snapshot?.windowId,
    completion: state.completion,
    recipientVerification,
    actions: state.events.filter((e) => e.type === 'decision').map((e) => e.message),
    screenshot,
    browserErrors,
  };
  writeFileSync(
    path.join(root, '.runtime', 'desktop-ui-smoke-' + scenario + '.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    recipientVerification
      ? 'PASS: recipient entered once, accepted as one token, subject entered; model final status: ' +
          state.status
      : scenario === 'youtube' ? 'PASS: Electron UI → Jev → agent-browser → YouTube search → independently verified video playback.'
      : 'PASS: Electron UI → Jev → general desktop controller → accessibility completion.',
  );
} finally {
  await session.close();
}
