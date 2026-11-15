# Simplification plan

Written 15 November 2026 against commit `2e16da4` on branch `orchestrator-snapshot`.

Goal: one Luna orchestrator that plans a request, runs controller sessions one after another, and
decides what context each session receives from the previous one. Nothing else. Each phase below
must keep or improve function, speed and reliability, and leaves all tests passing.

## Ground rules

- **No limits on steps, time or sessions.** This is the owner's decision. Nothing in this plan adds
  one. Stop and a replacement prompt remain the way to end a run early.
- One phase per commit, so any phase can be reverted alone.
- One writer at a time in these files (Claude or Codex, not both).
- No rule may be added to a prompt or to code to fix a single task. A fix must be stated as a
  general rule and checked against the whole live set in "Verification".

## Phase 1 — Restore fast site opening

**Problem.** `OPEN_URL` is refused unless the exact full address appears in the user's words or on
an observed page (`url-provenance.ts`, enforced at `planner-loop.ts:545`, `planner-loop.ts:552`
and `orchestrator.ts:117`). The rule was added after the model invented deep Sainsbury's
addresses. It also refuses `https://www.youtube.com` for "Open YouTube" and `https://twitch.tv`
for "open twitch.tv", because neither is a full address in the user's text. The navigator is then
sent to the address bar and Return, which Chrome ignores when sent natively.

**Change.**
- `url-provenance.ts`: add `isSiteRoot(url)`: http or https, no credentials, path empty or `/`,
  no query, no fragment. `urlIsObservedOrSupplied` accepts a site root. `ungroundedAddresses`
  does not report a site root.
- Keep the existing rule unchanged for any address with a path, query or fragment.
- Prompts (`planner.py` rule 4, `orchestrator.py` "Never invent URLs" paragraph): replace with
  one sentence: a site's root address may be opened when the user names the site; a path, query
  or identifier must come from the user or an observed page.

**One browser capability, not an address-bar routine.** Opening and searching must go through
the extension, never through the address bar and Return. The UKVI run of 04:02 ended with
`PRESS return` delivered to Chrome's address bar and nothing changing, which matches the earlier
finding that Chrome ignores a natively sent Return.
- `OPEN_URL` stays as it is: the extension opens the address in a new tab and the result is read.
- Add `SEARCH_WEB` with a text argument: the extension runs the query in the user's default
  search engine in a new tab (`chrome.search.query`, which needs the `search` permission, so the
  extension version rises and it must be reloaded once). The navigator then follows an observed
  result. No address is constructed.
- Both return the resulting page as the observation, so "did navigation happen" is checked by
  code in one place.
- Without the extension, the existing native route remains the fallback.

**Interface repairs found in the same run.**
- Key names: accept common aliases (`Enter` for `return`, and the like) at validation instead of
  refusing them. Four steps were refused for this.
- Text chosen by Luna: the literal-text check (`planner-loop.ts:579`) accepts text that appears
  in the session's `context`. Two steps were refused for this.
- `find` given the id of an offered scope is run as a read of that scope. Nine steps were
  refused as repeated searches because the navigator used `find` with `surface:window`.

**Tests.** Root accepted for a named site and for a bare domain; invented path or query still
refused in `OPEN_URL`, in typed text, and in a Luna objective; `SEARCH_WEB` opens a results page
in the extension end-to-end test; key aliases and Luna-supplied text are accepted.

**Risk.** A wrong root guess (for example `.com` instead of `.co.uk`). It is visible on the page
that opens, and Luna reviews that page before continuing.

**Done when.** "open twitch.tv" and "Open YouTube" each open in one action; a request that names
no address (the UKVI prompt) reaches a results page in one action; the Sainsbury's prompt still
cannot open an invented deep address.

## Phase 2 — One rule for repeating an action

**Problem.** Four mechanisms govern pressing a control again (`confirmedTwin`, `repeat`, the
`SET_VALUE` exception, `allowRepetition`), plus `pendingRequirement`, which blocks every other
action on a milestone while one outcome is unknown. In the four newest runs 25–45% of navigator
steps were refused, mostly by these rules.

**Change.**
- When the screen changed after a delivered action, record the action as confirmed by code
  (new reconcile source `observed_change`, at `planner-loop.ts:765`).
- Keep exactly one block: the same action may not be sent again while the earlier one is
  `uncertain`, or was delivered with no observed change and has not been inspected
  (`retryBlock` in `task-state.ts`, narrowed to that).
- Delete `confirmedTwin`, `pendingRequirement`, the `repeat` field, the `SET_VALUE` exception and
  `allowRepetition` from `task-state.ts`, `planner-loop.ts`, the contracts, `schemas.py` and both
  prompts.
- Irreversible actions are unchanged: the requirement must be marked irreversible and each
  action is confirmed with the user.

**Tests.** Same key pressed twice in a row succeeds; an uncertain delivery still blocks a resend;
an irreversible action still asks every time.

**Risk.** A reversible action could be repeated after it succeeded (for example adding an item
twice). The navigator sees the changed screen before choosing again, and the costly cases are
covered by the irreversible rule.

**Done when.** The local Wordle run has no "already succeeded" or "unresolved action" refusals.

## Phase 3 — One session contract

**Problem.** Seven overlapping records describe a session: action ledger, requirement status,
completion proposal, navigator report, handoff, session summary (built, sent, then dropped by the
broker) and memory record.

**Change.**
- Session input: `{ objective, doneWhen, context }`. Exact values Luna chose go in `context`; the
  literal-text check (`planner-loop.ts:579`) also accepts text found there. Remove `inputs`.
- Session result, built by code from the navigator's report and the ledger:
  `{ status, summary, facts, location, unresolved }`
  - `status`: `done | progress | needs_decision | blocked | unverified`
  - `facts`: text of the elements the navigator cited
  - `location`: app, window title, page address
  - `unresolved`: actions whose outcome is unknown
- This one object is what Luna receives, what is stored in memory, and what is traced.
- Delete `NavigationCompletionProposal`, the separate report type, `session-handoff.ts`, the
  `sessions` array, `stepsLeft`, and the fallback that stores the first 12 text items on screen
  as facts (no report means `facts: []`).

**Done when.** One type crosses the session boundary in each direction, and the traces show it.

## Phase 4 — Memory as assignment and result pairs

**Change.**
- Memory for a task is the ordered list of `{ assignment, result }` pairs from Phase 3.
- Refusals and retries are not stored; they already reach Luna through `issues` on the next call.
- Remove the record kinds `instruction`, `decision`, `correction`, `checkpoint` and the
  checkpoint/prefix logic. When the list exceeds the size budget, drop the oldest pairs.
  Appending still keeps the prompt prefix stable until that point.
- `semantic-memory.ts` becomes a few lines or is folded into the orchestrator.
- Linking separate requests (optional, small): add `context` (short text) to the task input,
  passed to Luna as caller context, and return `summary` and `location` in the final state. The
  voice agent can then hand the last result to the next request. No disk persistence.

**Done when.** A Wordle game's history holds only pairs, and its size is a fraction of the
current 43,000–47,000 characters.

## Phase 5 — Luna returns one decision

Owner's direction: Luna plans, the navigator executes, and that loops. The session result
already describes the current state, so on each call Luna decides directly what happens next:
continue, go back, finish, ask, or stop. There are no separate review or finish steps.

**Problem.** One Luna call today carries a plan, reviews, branch decisions and the next
assignment, each validated by code and each able to be refused. Refusals cost extra Luna calls:
nine "must cite fresh screen elements" in one run, 19 "already completed" in another.

**Change.**
- Luna's output is one decision:
  `{ next: continue | finish | blocked, objective, doneWhen, context, plan, message }`.
- Luna never asks the user. When something is unclear it chooses from the goal and what is on
  screen and carries on. A navigator question goes to Luna, not to the user.
- Luna alone ends a task. The navigator reports; it never finishes or blocks a task itself.
- `blocked` is a final report that the task cannot be completed, with the reason. It is only
  for something outside the system's reach:
  - a sign-in, verification code or CAPTCHA that needs the user;
  - the app, site or account is unavailable, or a needed permission is missing;
  - the control cannot be operated through accessibility or the extension, after the other
    routes were tried;
  - information only the user has, that neither the goal nor the screen supplies;
  - an irreversible action the caller did not allow.
  A slow page, a refused step, a confused navigator or an unfinished session is not blocked:
  Luna assigns another session.
- `plan` is Luna's own checklist, `[{ text, status }]`, returned in full on every call. Code
  stores it and sends it back; it does not validate order, dependencies or conditions.
- Remove `reviews`, `branches`, `milestoneId`, `MilestonePlan`, `reviewMilestone`,
  `finish_unverified` as a separate kind, and the CONDITIONS and review sections of the prompt.
- Code keeps two facts Luna cannot override, and applies them by labelling, never by refusing:
  - `finish` while any action's outcome is still unknown is reported as "completed, unverified".
  - An irreversible action (send, buy, delete, overwrite) follows the caller's
    `confirmIrreversible` setting, which already exists on the request. With it off, the
    action is sent without a prompt; with it on, the overlay asks once for that action.
    **Decision needed:** which is the default.
- A one-step request costs two Luna calls: one to assign, one to finish. There is no shortcut
  that lets the navigator end a task.

**Risk.** Completion rests on Luna's reading of the session result instead of on code-checked
citations. The session result's facts are still text of real elements cited by the navigator,
and unknown outcomes are still labelled.

**Done when.** No Luna decision can be refused for bookkeeping reasons, `milestone-plan.ts` is
deleted, and the Sainsbury's conditional still ends correctly on both branches.

## Phase 6 — One screen read per session

**Change.**
- Luna reviews the navigator's final observation of the session, with the same element ids.
  The orchestrator reads the screen itself only before the first session.
- Remove the separate `startDepth: 3` read in `orchestrator.ts`.

**Effect.** One fewer accessibility read per session, and reviews can cite what the navigator
actually saw, which removes the "must cite fresh screen elements" refusals.

## Phase 7 — One mode in the planner loop

**Change.**
- Orchestrated sessions become the only v2 path. Remove the standalone branches from
  `planner-loop.ts` (30 `mission` checks today): requirement declaration by the navigator,
  `exhaust`, the verification allowance, `maxSteps` and deadline handling, `budgets`.
- The loop's job becomes: run one session until its `doneWhen`, a needed decision, or an
  obstacle, then return the Phase 3 result.

**Decision needed.** Standalone v2 is the faster path for one-step requests today. Recommended:
remove it and rely on Phases 1 and 6 for speed; the snapshot commit keeps the old path.

## Phase 8 — Failures and questions

**Change.**
- Luna transport: a per-request timeout of about 20 s, then retry with growing delay for
  transient errors, shown in the overlay. This is a request timeout, not a task limit.
- A non-retryable provider rejection (the `invalid_prompt` case): retry once with history cut to
  the last pair; if it fails again, end as failed with the provider's message.
- Remove `ask_user` from Luna's and the navigator's output, the conversion of a question into a
  retry, and the "questions disabled" prompt text. Nothing asks the user (see Phase 5).
- Remove the fake "Inspect before judging availability" session.
- Only broker and native errors become session results. Any other exception fails the task
  visibly instead of being reported to Luna as "blocked".

**Decision needed (not a step, time or session limit).** If Luna returns the same refused
decision three times in a row on an unchanged screen, end as blocked with the refusal text.
Recommended, because that state cannot make progress and a voice session has nobody watching.
Left out if the owner says no.

## Phase 9 — Prompts

After Phases 1–8 remove the mechanisms, rewrite both prompts as short principles.

- Delete every sentence about repeat flags, branches, budgets, milestone ids and disabled
  questions.
- For each remaining rule that traces to one run, remove it and run the live set. Keep it only
  if a prompt fails without it.
- Target: about 60 lines each (137 and about 135 today).

## Phase 10 — Delete the old code

Its own commit, after the phases above.

- **v1 controller:** `desktop-loop.ts`, `tree-browser.ts`, `desktop-candidates.ts`,
  `supervision.ts`, `decision-context.ts`, `completion-verifier.ts`, `value-entries.ts`,
  `write-history.ts`, `resolve-action-text.ts`, `target-identity.ts`, `action-result.ts`,
  `choice-budget.ts`. First move the three things v2 uses (`measuredValue`, the `LoopHost` type,
  `exactInputs`) into v2.
- **Broker:** `supervisor.py`, `jev.py`, `text_resolution.py` and the `decide`, `resolve-text`
  and `supervise` routes. `grounding.py` and `typesafe.py` stay only if the Jev grounding arm is
  kept; decide that from the evaluation, otherwise delete both.
- **Old browser driver:** `electron/browser/`, `hybrid-workspace.ts`, and the `agent-browser`
  dependency if nothing else needs it.
- **TextEdit mode:** `mode: 'textedit'`, `PreparedDocument`, `LocalTestPolicy`, the TextEdit loop
  in `navigation.ts` and the fixture in `native.ts`.
- **Overlay:** the controller toggle and supervisor settings.
- **Tests:** delete a test file only when the file it tests is deleted. Tests of the shared
  desktop layer (workspace, action verification, paste, traversal, modal scope) stay.
- **Scripts:** `launch.mjs` uses only `native-smoke.ts`, `page-bridge-e2e.ts`, `test-paste.mjs`
  and `eval/`. Check each remaining smoke script by hand, then delete the ones for v1.
- **Contracts:** keep the TypeScript schemas as the single definition. In the broker, validate
  only the model's output; stop mirroring every request type in `schemas.py`.
- **Docs:** replace `controller-redesign.md` with a one-page description of the final design;
  cut `verification.md` to current status and leave history to git.

## Verification

Run after every phase.

- `npm test`, `npm run typecheck`, and `pytest` in `services/decision-api`.
- `npm run test:extension` when the page bridge is touched.
- The same live set, three runs each, through the overlay and the Chrome extension:
  1. open twitch.tv
  2. Open YouTube, search for a phrase, play the first video
  3. the Sainsbury's conditional prompt
  4. the local Wordle game
  5. open Messages and draft to a placeholder recipient, unsent
  6. write a given sentence into a new TextEdit document
- Record for each: completed or not, seconds, Luna calls, navigator steps, refused steps.

Targets: no prompt completes less often than at the snapshot commit; refused steps under 10%;
opening a named site in one action.

## Order and size

Phases 1 and 2 remove the largest live failures and are independent of the rest. Phases 3–7
depend on each other in that order. Phase 8 can follow Phase 3. Phases 9 and 10 come last.

Rough expectation, to be confirmed as work lands: `planner-loop.ts` from 831 lines to about half,
both prompts to under half, and about 3,000 lines of old controller, broker and driver code
removed.
