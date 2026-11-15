# Controller redesign spec

Status: implemented, covered by unit tests with fake bridges and scripted models, and run live on a handful of single trials (see verification.md). It is the overlay's default as of 15 November 2026 at the user's request, and is still experimental: no baseline or repeated-trial comparison exists. See "Implementation status" below for what differs from the original draft.
Numbers marked *initial* are starting values to tune against the evaluation harness, not measured optima.

## 1. Purpose

Replace the controller and state-management layer (`apps/desktop/electron/controller/`) with a design that has one owner of task progress, one record of effects, relevance-based observation, and a bounded way to finish. Keep the Electron shell, the native bridge, the delivery protections and the broker.

The redesign is justified only if it beats the current controller on independently checked end-to-end workflows. Section 11 defines that comparison. It is built first.

## Implementation status

Select the new controller with `controller: 'v2'` on the task input, or "New planner (experimental)" in the overlay settings. `grounding: 'jev'` selects arm B.

| Phase | State | Notes |
|---|---|---|
| 0 | Built; baseline **not run** | Harness in `scripts/eval/`, JSONL traces for both controllers, the apostrophe fix and inference retries in the current controller. A live run needs a process with Accessibility permission and takes over the desktop. |
| 1 | Built and tested | `controller/v2/identity.ts`, `task-state.ts`. |
| 2 | Built and tested | `observation-index.ts`, `settle.ts`, direct deep reads in `tree-budget.ts`. |
| 3 | Built and tested | `planner-loop.ts`, broker route `/navigation/plan`, overlay question and confirmation. |
| 4 | Built; comparison **not run** | Broker route `/navigation/ground`. The decision on Jev needs the live comparison. |
| 5 | Partly built | Menu command index is built. Shortcut discovery is **not possible** with the current native helper (7.3). A Chrome extension bridge is built and tested in a separate Chromium (`extension/page-bridge`, `apps/desktop/electron/page/`); it has not yet been loaded into the user's Chrome. No screenshot observation. |
| 6 | Spiked; **not built** | The measurement does not support it (7.1). |

Changes made while implementing, with the reason:

- **Termination (9.3).** The draft started verification as soon as every open requirement had one delivered action and then refused further actions. One requirement routinely needs several actions, so that rule would have refused the second step of most tasks. It is replaced by a bound on consecutive steps that deliver nothing.
- **Evidence rule (6.2).** Code cannot tell a written control that is the subject of a requirement (a document body) from one that is only a means (an address bar). The first version let the planner declare which; in a live run it declared an address bar to be the subject, never submitted it, and the task was reported complete. A field the task typed into is now never evidence on its own, and neither is an entry in the window list. A pure text-entry task therefore ends as "entered and read back, not otherwise confirmed".
- **Identity (6.1).** Ancestors carry their position, so the same button in two rows differs; the root of a read is a wildcard, so a control read through a narrower scope is still recognised; a native id counts only together with the label or position, because applications reuse one id across a family of controls.
- **Repeats (6.3).** Reconciling an action as confirmed does not make it free to send again. That needs `repeat=true` from the planner. Requirement text is fixed once stated; rewording is ignored.
- **Settling (7.1).** The controller reads until the first observable change, not until two reads agree. A second full read per action cost about a second and told little.
- **Reconciliation (6.3).** Reconciliations and requirement statuses travel with every step instead of being a step kind of their own, so confirming the last action and taking the next one is one model call.
- **Planner output (8).** One flat object with every field required, because both providers' strict modes handle that reliably. A `blocked` kind was added.
- **Not built:** resuming a task from a trace after a crash (state is serialisable and model calls are retried in place, but nothing reloads it); the completion Noul as a verification hint; clearing a field to empty.

## 2. Evidence this responds to

All figures come from `.runtime` artifacts and `docs/verification.md`. Each is a single trial.

| Observation | Source |
|---|---|
| 25 supervisor calls took 78 s of a 148 s run; 17 were `no_progress` reviews | `word-comparison-luna.json` |
| At least 42 of 117 Jev calls in that run were pure tree reads | same |
| One click needed three supervisor calls and 9.2 s, of which about 4.1 s was neither model | `new-tab-ui-smoke.json` |
| 48 decisions ran after an email had already been sent; 57 after a video opened | `verification.md` |
| Completion reported with a 24-valued toolbar field while the text was 12 pt | `word-comparison-first-sol.json` |
| A live Chrome read kept 49 of 487 actions under the depth-layer rule | `verification.md` |
| An HTTP 429 and an unparseable supervisor response each ended a run | `word-comparison-sol.json`, `word-comparison-second-luna.json` |
| A web live-region `alert` was treated as a blocking dialog and hid every other control | `verification.md`, modal classification |

## 3. Goals and non-goals

Goals:

1. One component owns the original goal, the outstanding requirements and the action arguments.
2. One structured record answers "what was attempted, what was delivered, what is known about its effect".
3. The model sees controls chosen by relevance to the current step, at any depth.
4. Every task ends in a bounded number of steps after its last mutation, with an honest terminal state.
5. Code restricts the action space only on observed evidence, never on a role or a guess.
6. Reliability claims rest on repeated, independently checked workflows.

Non-goals for this redesign:

- Windows or Linux support.
- Voice, gesture, drawing or avatar features. They stay outside the loop (section 12).
- A guarantee of exactly-once effects in applications that expose no way to observe the effect.
- Arbitrary shell, script or free-coordinate tools for the model.

## 4. Design principles

1. **Facts and interpretations are separate types.** An observation carries what accessibility reported. Anything derived (possible blocker, likely editor, landmark) is a hint attached to it.
2. **Hints may annotate or reorder. Only evidence may restrict.** The only things that remove an action are: an explicit reported state (`disabled`, `hidden`, `modal`), an executor precondition that fails at dispatch time, or task-state rules in section 6.
3. **Delivery is not outcome.** "The input was sent" and "the application did what was asked" are recorded as two different fields and never inferred from each other.
4. **Models propose, code binds.** A model selects identifiers from the current observation. It never writes a ref, window ID or native ID. This property is kept from the current design.
5. **Agreement between models is not evidence.** A requirement is evidenced by an observed fact that a typed check or a cited observation row supports.
6. **Unknown is a valid final answer.** When an application does not expose the evidence, the task ends and says so.

## 5. Architecture

```text
Text / voice / gesture input
            |
   NavigationController          lifecycle: start, replace, cancel (kept)
            |
        TaskState                requirements + effect ledger + trace (new)
            |
         Planner                 one LLM call per step (new)
            |
   Grounding (optional)          Jev picks a target among top-K (experiment arm)
            |
        Executor                 preconditions, dispatch once, readback (mostly kept)
            |
  Observer + ObservationIndex    full-window read, settle, relevance retrieval (new)
            |
        TaskState                reconcile effect, re-check requirements
```

Ownership:

| Component | Owns | Must not |
|---|---|---|
| TaskState | Requirements, effect ledger, trace, retry eligibility | Call models or the desktop |
| Planner | Interpreting the goal, the next operation, arguments, requirement status proposals | Invent identifiers, mark a requirement evidenced without a cited fact |
| Grounding | Choosing one target among supplied candidates | Change the operation or arguments |
| Executor | Target freshness, focus, capability, cancellation, single dispatch, readback | Decide what the task needs or whether it succeeded |
| Observer | Reading, settling, indexing, capability report | Hide controls on inference |

The loop is an explicit state machine with typed transitions:

`Observing -> Planning -> (Grounding) -> Validating -> Dispatching -> Settling -> Reconciling -> Observing ...` and `-> Verifying -> Terminal`.

Every transition appends one typed event to the trace. Notices, history shown to the model, and guards are derived from TaskState. No component matches on prose strings.

## 6. Task state

### 6.1 Element identity

One module defines identity and is used by the ledger, the checks and retrieval. It replaces the separate keys in `desktop-loop.ts`, `write-history.ts`, `value-entries.ts`, `outcome-checks.ts` and `target-identity.ts`.

```ts
type ElementIdentity = {
  app: string; windowId?: string;
  role: string; label: string;
  nativeId?: { kind: string; value: string };
  ancestorRoles: string[];      // full role path, not the last five names
  siblingIndex: number;         // position among same-role siblings
};
type Match = 'exact' | 'strong' | 'weak' | 'none';
```

`strong` requires a native ID plus role, or label plus the full ancestor path plus sibling index. `weak` is label and role only. Checks that read a value or state require `strong` or better and a unique match. Presence checks accept `weak`.

### 6.2 Requirements

The planner states the task's requirements once, from the original goal, on its first call.

```ts
type Requirement = {
  id: string;
  text: string;                       // one user-visible obligation
  irreversible: boolean;              // send, submit, delete, purchase, overwrite
  checks: OutcomeCheck[];             // existing typed predicates; may be empty
  status: 'open' | 'evidenced' | 'refuted' | 'unverifiable';
  evidence: { observationId: string; row: string }[];
};
```

Rules:

- Requirements can be refined (a target gets bound, a check gets added). They cannot be deleted. Any edit is logged with the planner's stated reason.
- `evidenced` needs every typed check to pass, or, when there are no typed checks, at least one cited row from a current complete observation.
- A control the task wrote into as a means to something else does not evidence the result. When the planner writes text it declares whether the target is the subject of the requirement (`writesSubject`); evidence or a check that cites a non-subject written control is rejected. This encodes the toolbar-value failure as a rule instead of a prompt sentence. It still relies on the planner's declaration at write time.
- `unverifiable` is set by the bounded exit in section 9, never by the planner alone.

### 6.3 Effect ledger

One append-only list replaces `performed`, `uncertain`, `WriteHistory`, `ValueEntries`, `declinedCompletionStates`, `inspected` and the string history.

```ts
type Effect = {
  id: string; step: number;
  requirementId?: string;             // which obligation this serves
  operation: string; args: { text?: string; key?: string; direction?: string };
  target?: ElementIdentity;
  recipient?: ElementIdentity;        // focused element, for keyboard input
  risk: 'read' | 'reversible' | 'irreversible';
  delivery: 'proposed' | 'not_delivered' | 'delivered' | 'uncertain';
  outcome: 'unknown' | 'confirmed' | 'refuted';
  readback?: { expected?: string; observed?: string };
  delta: { added: string[]; removed: string[]; scopeChanged: boolean };
  reconciledBy?: { observationId: string; row?: string; check?: OutcomeCheck };
};
```

Retry eligibility is computed from the ledger, not from a UI fingerprint:

- An action equal in operation, arguments and `strong`-matching target to an effect with `delivery: uncertain` or `outcome: unknown` is withheld until that effect is reconciled.
- Reconciling sets `outcome` to `confirmed` or `refuted` and must cite an observation. A `refuted` effect may be retried. This is the removal transition the current uncertainty set lacks.
- Repeating a `confirmed` effect is allowed only when the planner names an open requirement that needs it (for example "open two tabs").
- Read operations are never withheld. Repetition of reads is handled by the step budget and by showing the planner what it already read.

### 6.4 Change detection

The single `fingerprint` is split:

- `viewKey`: app, window, surface, scope. Identifies what was looked at.
- `contentFacts`: role, label, value and states per element, excluding focus, bounds and refs. Used for deltas and for settle detection.

Neither is used to decide whether an action may be retried.

### 6.5 Trace and checkpoint

Every task writes `.runtime/traces/<taskId>.jsonl`: each transition, each model request and response, each observation digest, each ledger change. This replaces the 150-event ring as the record of a run.

TaskState is serialisable. A model call that fails with a timeout, HTTP 429 or 5xx, or an unparseable response, is retried with backoff (*initial*: 3 attempts, 0.5 s, 2 s, 6 s) from the same state. Model calls send no desktop input, so retrying them is safe.

## 7. Observation

### 7.1 Read and settle

- Read the selected window once per observation, to the existing local ceiling (2,048 nodes, depth 12). Avoid the current re-read at every depth from 3 upward; request the needed depth directly and fall back to shallower reads only on a limit error.
- After any mutation, poll until `contentFacts` is equal across two consecutive reads (*initial*: 150 ms interval, 2 s cap), then hand the result to reconciliation. Waiting is no longer a model-chosen action. The planner can still request a longer wait with a stated condition.
- Record time spent in native calls per step in the trace.

Spike result: the bundled `agent-desktop mcp` stdio mode answered `list-apps` in 51–57 ms per call, against 40–80 ms for a fresh process. Process spawning is therefore not where native time goes; the number and depth of reads is. The stdio mode advertises tools only, with no notification stream, and refs are resolved from stored ref maps rather than live handles. A persistent helper is not built. Native time is addressed instead by reading once at depth and by settling in code.

### 7.2 Index and retrieval

The full read is indexed locally. The planner receives a bounded selection, not a depth-truncated layer.

Always included:

- Window title, app, surface and a region outline: named landmarks, toolbars, menus and lists with child counts.
- The focused element and its ancestors.
- Any node reporting `modal`, and any native sheet, with its children.
- Elements added, removed or changed since the previous observation.
- Elements bound to open requirements or unreconciled effects.

Then the top-K (*initial*: 40) elements by relevance to the planner's query. Scoring starts lexical: tokens from the planner's query and the active requirement against label, description, value, role and ancestor labels. The planner writes its query after seeing the outline, so it can use the interface's own language.

The planner can issue `find` (a new query, optionally scoped to a region) and `read` (a region, another window, the menu bar) as steps. These replace `BROWSE_TREE`, `INSPECT_REGION`, `GO_PARENT`, `GO_ROOT` and sibling paging.

Unlabeled actionable controls are offered with a synthesised descriptor (role, nearest labelled neighbours, position within parent) and flagged low-information. They are not dropped.

### 7.3 Menu command index

For native applications, read the menu bar once per app, cache it for a minute, and index every enabled item with its path. Menu items are retrievable like any other control and are dispatched against the cached menu bar snapshot.

Not achievable yet: the native helper's snapshot and `get` expose name, role, value, states, bounds and actions, but no key equivalent. Discovering shortcuts needs a native patch that reads `AXMenuItemCmdChar` and its modifiers. Until then the fixed 18-key allowlist in `workspace.ts` stays. Whether a click on an item of a closed menu is delivered by the helper is also unverified; if it is not, the planner opens the parent menu first.

### 7.4 Capability report

Each observation states what the surface can and cannot support: whether text values are readable, whether selection and attributed text are exposed, whether the tree was complete, how many actionable nodes lacked labels. The planner uses this to mark a requirement as needing another observation method, and the bounded exit uses it to explain an `unverifiable` result.

## 8. Planner

One LLM call per step through a new broker route, `POST /navigation/plan`, using the existing provider adapters and strict structured output.

Input, within a fixed token budget (*initial*: 12k):

- Original goal and exact user-supplied literals.
- Requirements with status and evidence.
- Unreconciled effects, then the last few reconciled ones, as structured rows.
- The observation selection from 7.2 and the capability report.
- The remaining step and verification budgets.

Output is exactly one of:

```ts
type Step =
  | { kind: 'act'; requirementId: string; operation: string; target: string /* candidate id */;
      args?: { text?: string; key?: string; direction?: string };
      risk: 'reversible' | 'irreversible'; expect: string }
  | { kind: 'find'; query: string; scope?: string }
  | { kind: 'read'; scope: string }
  | { kind: 'wait'; until: string; maxMs: number }
  | { kind: 'reconcile'; effectId: string; outcome: 'confirmed' | 'refuted'; evidence: string }
  | { kind: 'ask_user'; question: string }
  | { kind: 'finish'; statuses: { requirementId: string; status: string; evidence: string[] }[] };
```

Points that differ from today:

- The planner chooses operation and arguments, then a target. The choice list is the retrieved targets, not every control multiplied by every operation and input.
- Text arguments come from the planner. When it marks an argument as a literal from the user's goal, code verifies it is an exact substring. The quote-extraction regex and the separate text-resolution route are retired with the old loop.
- `expect` is the planner's stated observable result. Reconciliation compares the delta against it and hands the comparison back on the next call.
- `ask_user` pauses the task and shows the question in the overlay. Today an ambiguous goal ends in a guess or a stop.

The prompt is kept short. Rules that matter are enforced in sections 6 and 9 as code.

## 9. Executor, risk and termination

### 9.1 Preconditions

The existing checks stay: snapshot-bound refs, advertised capability, value unchanged since observation, window focus for keyboard input, paste transaction checks, dispatch once, readback. Added:

- **Stable:** the target's bounds are equal across two reads before a click.
- **Recipient:** immediately before a key press, the focused element must `strong`-match the intended recipient recorded in the step.
- **In view:** an offscreen target with `ScrollTo` is scrolled into view by the executor as part of the action, then re-read.

A failed precondition returns `not_delivered` with a reason. It never changes what the planner is offered next.

### 9.2 Irreversible actions

An `act` step with `risk: irreversible` is dispatched only when its `requirementId` names a requirement the planner marked `irreversible` on its first call, from the original goal. A setting (default on) additionally asks the user to confirm in the overlay. The classification is a model judgement and can be wrong. The gate limits damage; it does not prove safety.

### 9.3 Termination

- Step budget and deadline stay (*initial*: 60 steps, 10 minutes; the current 160 and 20 are sized for hop-by-hop traversal).
- (Superseded by the paragraph below.) Verification begins when every open requirement already has a delivered effect serving it, or needed none. A verification budget starts at that point (*initial*: 6 read steps or 20 s). Mutations are not offered during it unless an effect is `refuted`, which ends verification and returns to planning.
- When the verification budget runs out, each still-open requirement whose effect was delivered becomes `unverifiable` and the task ends.

As built: counting starts at the last delivered action that was more than a view change. While work is outstanding, 12 consecutive steps without such an action end the task as `blocked` (*initial*). Once every open requirement has delivered work, the allowance is 6 (*initial*), and running out ends the task as `completed_unverified`. A delivered action resets the count. Code cannot tell further work from redundant work, so nothing is refused for being "after completion"; an identical unreconciled action is still withheld by the ledger, and an irreversible one still needs its requirement and the user.

Terminal states:

| State | Meaning |
|---|---|
| `completed` | Every requirement evidenced |
| `completed_unverified` | Effects delivered; the listed requirements have no observable evidence. The reason from the capability report is included |
| `needs_user` | Waiting on an `ask_user` answer or an irreversible confirmation |
| `blocked` | A requirement cannot be advanced with available capabilities |
| `failed` | Unrecoverable error after retries |
| `cancelled` | Stopped by the user |

The completion Noul, if Jev is kept, may suggest starting verification early. It cannot set a requirement's status.

## 10. Jev's role

Not assumed. Three arms run on the same executor and harness:

- **Current:** the existing supervisor plus Jev controller.
- **A:** planner only. The planner selects the target itself from the top-K.
- **B:** planner plus Jev. The planner emits operation, arguments and a target description. Jev picks among the top-K through `POST /navigation/ground`.

Jev stays if arm B is no worse than A on success and false completion and is faster by a margin that matters at the median. Otherwise the default is A.

## 11. Evaluation harness

Built before any new controller code, and run first against the current controller to set the baseline.

**Tasks.** Reuse the existing smoke scripts and oracles: new Chrome tab (native tab inventory), Word text plus 24 pt (`scripts/fixtures/read-text-style.swift`), Outlook draft recipient and subject without sending (`scripts/lib/verify-recipient.mjs`), video playback (`scripts/lib/verify-browser-video.mjs`), TextEdit entry, Calculator, interrupt and replace. Add:

- A task that is already satisfied at the start. Correct behaviour is no mutation.
- A task that is impossible with the exposed controls. Correct behaviour is `blocked` with no mutation.
- A page with a live-region announcement (the modal regression).
- A real blocking sheet, such as closing an unsaved document.
- An ambiguous instruction. Correct behaviour is `ask_user`.

**Starting states.** Each task runs from several: app closed, app open with existing content, a dialog already open, another window focused.

**Trials.** At least 10 per task, starting state and arm. Ten trials only separate large differences; use 20 or more where two arms are close.

**Metrics**, all judged by the independent oracle, not the controller's own status:

- Success rate.
- False completion rate: controller reports complete, oracle disagrees.
- Duplicate or unrequested mutations, and wrong-target mutations.
- Terminal state distribution.
- Model calls by type, wall time at p50 and p90, and the split between model time and native time.

**Gates to make the new controller the default** (proposed):

- No duplicate irreversible action anywhere in the suite.
- False completion rate below the current controller's and below 5%.
- Success rate at or above the current controller's on every task family.
- Median wall time no worse.

**Replay.** A tool replays recorded planner requests from traces against a model offline, so prompt and retrieval changes can be compared without a live desktop.

## 12. Other inputs

Voice, gestures, drawing and avatars submit a `TaskInput` or a target hint, display progress from the trace, and interrupt through `NavigationController`. A target hint enters retrieval as an always-included element. None of them adds a planner or a second executor.

## 13. Migration

The new controller is built against the existing `WorkspaceBridge` interface (`observe`, `act`, `takeActionReport`) and selected by a task input flag, so both controllers run on the same executor.

| Phase | Work | Exit |
|---|---|---|
| 0 | Harness, JSONL traces, baseline on the current controller. Fix the apostrophe extraction bug and add inference retries in the current controller so the baseline is fair | Baseline numbers recorded |
| 1 | Identity module, requirements, effect ledger. Pure code with unit tests | Ledger rules tested, including refute-then-retry |
| 2 | Observation index, retrieval, facts and hints, settle, capability report | Retrieval returns the needed control in recorded captures where the layer rule dropped it |
| 3 | State machine, planner route, arm A behind the flag | Arm A completes the suite |
| 4 | Arm B. Compare Current, A and B | Decision on Jev and on the default controller |
| 5 | Menu command index. Then, if the capability reports justify it, a browser extension or screenshot-based observation | Per-feature harness gain |
| 6 | Persistent native helper, if the spike supports it. The spike did not: see 7.1 | Lower native time per step |

Kept: Electron shell and IPC, `NavigationController` lifecycle, `WorkspaceBridge`, `ActionVerifier`, focus-and-paste, the native patch, broker authentication and provider adapters, contract validation.

Removed once the gates pass: `desktop-loop.ts`, `supervision.ts`, `completion-verifier.ts`, `write-history.ts`, `value-entries.ts`, the projection in `tree-browser.ts`, the cross-product in `desktop-candidates.ts`, `fingerprint` in `decision-context.ts`, `resolve-action-text.ts`, and the broker's supervisor and text-resolution routes.

## 14. Open questions

1. Does the patched native helper report `modal` on real dialogs in Chrome, Word and Outlook? No recorded capture in `.runtime` contains that state. Section 7.2 depends on it.
2. Answered by the spike in 7.1: the stdio mode neither removes meaningful cost nor delivers notifications.
3. Which planner model meets the latency needed for one call per step? Recorded supervisor calls ranged from about 0.5 s to 3 s depending on provider and payload.
4. Is one planner call per action acceptable, or should the planner be able to emit a short sequence with a typed postcondition per step?
5. Is lexical retrieval enough when the user's language differs from the interface's, or is an embedding index needed?
6. Is the Screen Recording permission acceptable for a screenshot-based fallback? The current design deliberately avoids it.
7. Who reviews the irreversible classification when the planner gets it wrong in the permissive direction?
