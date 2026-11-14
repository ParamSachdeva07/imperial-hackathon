// Read-only contract probe: observe Chrome and save the exact next decision
// request. This script never dispatches the resulting model choice.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceDesktopBridge } from '../apps/desktop/electron/desktop/workspace';
import { resolveNativeBinary } from '../apps/desktop/electron/desktop/native-binary';
import { desktopCandidates } from '../apps/desktop/electron/controller/desktop-candidates';
import { TreeBrowser } from '../apps/desktop/electron/controller/tree-browser';
import { decisionPage } from '../apps/desktop/electron/controller/decision-context';
import { nativeActionBudget } from '../apps/desktop/electron/controller/choice-budget';
import { TaskInputSchema, DesktopDecisionRequestSchema } from '../packages/contracts/src/index';

const root = process.cwd();
const workspace = new WorkspaceDesktopBridge(resolveNativeBinary(root), path.join(root, '.runtime', 'choice-budget-probe-state'));
const observation = await workspace.observe({ app: 'Google Chrome', surface: 'window' });
const input = TaskInputSchema.parse({ goal: 'Open Chrome.', provider: 'jev' });
const actions = desktopCandidates(observation, input);
const browser = new TreeBrowser(observation);
const view = browser.view(actions);
const request = decisionPage(view.observation, view.candidates, input, crypto.randomUUID(), 1, 0, new Set([0]), []);
request.tree = browser.metadata();
DesktopDecisionRequestSchema.parse(request);
assert.ok(request.candidates.length <= nativeActionBudget(request.tree.canGoUp, true));
writeFileSync('.runtime/choice-budget-request.json', JSON.stringify(request, null, 2));
console.log(JSON.stringify({ before: actions.length, after: request.candidates.length, pages: request.page.count,
  rows: request.observations.reduce((sum, s) => sum + s.text.length, 0),
  notices: request.notices.filter(n => n.includes('budget') || n.includes('Native read')) }));
