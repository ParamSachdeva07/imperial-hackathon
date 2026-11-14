# Current verification — modal classification, 14 November 2026

- Failed user run: 18 decisions ended with `No open alert in window w-29041`. The controller had scoped both models to a web live-region `alert` and repeatedly attempted dismissal. A native read showed a route-announcement node with no `modal` state; the native alert-surface query correctly found no open alert surface. The failure was in our controller's interpretation, not unavailable Chrome tab controls.
- `activeModal` now requires explicit modal state, or the native attached-sheet role. Plain alert/dialog/alertdialog roles and focus alone do not force scoping. This is not keyed to Chrome, a site, a control name or an identifier. Real modal nesting and native sheet handling remain tested.
- Optional menu/sheet/alert/popover reads that report absence now re-read the window without sending input. Permission failures, unresponsive apps and missing scoped elements still propagate rather than being mislabeled as absence.
- **276 TypeScript tests / 18 files**, typechecking and production build passed. Native adapter and Python broker code were not changed by this patch.
- Real Chrome regression: **9.204 seconds**, **4 Jev decisions**, **3 Cerebras supervisor calls**, **one creation attempt**. Independent native tab inventory increased **51 → 52**, and the new tab was selected. No Chrome debugger or anonymous profile was used. Test guard would reject a second creation before dispatch; no such rejection occurred.
- Artifacts: `.runtime/chrome-modal-root.json`, `.runtime/chrome-modal-regression.log`, `.runtime/new-tab-ui-smoke.json`. One passing workflow does not establish broad reliability; the split planning/state/completion architecture remains under review.

# Earlier verification — generalization pass, 14 November 2026

- Shared provider validation now enforces the 255-choice limit for every Jev question, including text resolution. Long instructions use bounded boundary groups and exact source slicing, with one extra call only above 254 tokens. Tests cover the 254/255-token boundary, 500-token Unicode input, spans crossing groups, invalid selections and sanitized provider errors. These tests establish the size/selection contract, not perfect model interpretation.
- Target catalogs and outcome checks preserve observed window/native IDs, kind and ancestor paths. Tests cover duplicate labels, renamed windows/controls, repeated IDs, wrong/missing identities, temporal measurements, oversized identity rejection and Python-to-TypeScript optional-field compatibility.
- Cached branches remain selectable after repeated visits. Visit hints, no-progress review and overall task budgets remain in place.
- Field-entry context records subsequent keys/clicks and fresh observations without treating Enter, Tab, focus loss or a named option as proof of application. Missing/ambiguous fields remain unknown; immediate-apply controls do not automatically require another commit. Exact write verification and duplicate suppression remain unchanged.
- **258 TypeScript tests / 17 files**, **97 Python tests**, typechecking and production build pass. Model transports in regressions are mocked; native adapter code is unchanged.
- Live read-only Chrome observation still projected 487 raw actions into 49 candidates plus STOP/DONE. The real Jev request succeeded in **0.542 seconds**, selected DONE and returned a completion Noul of 0.95. No resulting action was dispatched. This checks the transport contract, not an end-to-end navigation task.
- A read-only Cerebras `gpt-oss-120b` supervisor request succeeded in **2.429 seconds**, retained its selected observed window ID, and passed the Electron client contract. The input catalog carried seven native-ID targets. Artifacts: `.runtime/generalization-live-results.json` and `.runtime/generalization-guidance.json`.
- Restarted the development app after the changes; the minimal overlay shows **Connected / Ready** with an empty instruction field.
- Deferred: broader unlabeled-container clicks, custom-editor paste eligibility and universal completion verification. Existing native safeguards remain. Word formatting, YouTube playback and email completion were not rerun or claimed fixed by this pass.

# Earlier verification — action-layer budget, 14 November 2026

- The reported Chrome error was upstream HTTP 422: TypeSafe permits at most 255 criteria in a Choice question. The prior node-based projection could emit more actions than nodes. A read-only synthetic request reproduced the provider validation error.
- The projection now adds complete layers in order, counting generated actions plus broker navigation choices. The entire first overflowing layer is excluded; no partial layer or sibling subset is sent. Boundary descent and parent/root traversal repeat the same rule. More than 255 nodes are allowed when the actions fit. Local native reads retain separate resource limits.
- **246 TypeScript tests / 16 files**, **87 Python tests**, typechecking and application build pass. Regressions cover exactly 255 choices, exclusion at 256, non-actionable nodes, multi-branch atomic exclusion, boundary descent/backtracking, and broker rejection before an oversized provider call.
- A fresh read of regular Chrome produced 487 raw candidate actions. Whole-layer projection retained 49 actions across eight complete layers; STOP and DONE made **51 total choices**. The real TypeSafe request succeeded in **0.279 seconds**, selected DONE and returned a completion Noul of 0.96. No desktop action was executed by this probe. This verifies the request budget for that observed state, not universal navigation reliability.
- Probe: `scripts/choice-budget-probe.ts`; local artifacts: `.runtime/choice-budget-request.json` and `.runtime/choice-budget-probe-result.json`.

The following interrupt checkpoint predates the action-budget correction. Its former 255-node policy has been replaced by the action-based policy above.

# Earlier verification — interrupt and replace, 14 November 2026

- New prompts replace an active or paused run. Replacement validates the prompt, cancels the old run, waits for any dispatched action to settle, then starts with a new task ID. A late old inference cannot dispatch into the new task. Stop also cancels a replacement waiting for an action to settle.
- The input clears after an accepted start, stays editable during execution, and preserves edits typed while a start/replacement request is pending. The always-on-top overlay defaults to 380 × 190 pixels. Live layout checks passed at 340 and 380 pixels, including expansion/collapse and keyboard-accessible controls.
- The live interruption test held a real Jev response for “Open Calculator.” and submitted “Open TextEdit.” while it was pending. Input clearing, editing, task replacement, and opening TextEdit succeeded. The subsequent completion check repeatedly reviewed the open application and then proposed creating a document; the test guard rejected that unrelated mutation. Thus the handoff worked, but the full live model task did **not** pass. The test retains its failing completion assertion. Artifact: `.runtime/interrupt-ui-smoke.json`.
- Latest checks: **242 TypeScript tests / 16 files**, **85 Python tests**, and **1,720 native core tests** pass; the application build passes. Unit tests use mocked model transports. Replacement regressions cover action settling, late inference, invalid prompts, and Stop during handoff.
- The configured supervisor is **Cerebras gpt-oss-120b, low reasoning**. Jev action choice and Noul goal completion share one provider call; action confidence thresholds remain absent.
- Native observations include all complete tree layers that fit within 255 nodes (root included), up to a depth-12 safety ceiling. An overflowing layer is excluded in full. Native read-only references allow subsequent descent into named structural regions. A single immediate layer wider than the budget remains an explicit observation limit.
- Context compaction shares tree-node IDs instead of repeating paths for every action. A recorded TextEdit request shrank from 95,911 to 64,544 characters and changed from provider HTTP 400 to HTTP 200. This does not establish that every possible tree fits every provider limit.
- Actual email test: one Send action was dispatched to `zcabps0@ucl.ac.uk`, subject “Desktop Assistant test”, body “Hi”. Pre-send recipient/body checks passed. Outlook showed the sent and received copies in one conversation. The controller subsequently looped during verification and was cancelled after 48 decisions / 103.25 seconds. This is a successful send, **not** a successful end-to-end controller run; no second send was dispatched.
- YouTube test: the correct IBM Technology RAG video opened in regular Chrome through native Accessibility. Advancing playback was not independently established; the verification loop was cancelled after 57 decisions / 92.11 seconds. The structural-region reference fix was applied afterwards and has only read-only live verification so far.
- Latest Word comparison: the controller reported completion after 13 decisions / 19.18 seconds, but the independent attributed-text check found 12 pt despite a 24-valued toolbar field. This is a failed formatting test. Generic value-entry tracking was extended afterwards; applied-format verification still needs another end-to-end test.

## Historical checkpoints

The following records describe earlier code and configuration. Their model selections and test counts are historical, not the current settings above.

# Result checkpoint verification — 14 November 2026

- The recorded user Chrome task contained three Cmd+T decisions and 25 supervisor review entries before cancellation at decision 28. The live UI snapshot is `.runtime/reported-chrome-run-ui.json`.
- After the general result-checkpoint changes, the identical instruction (`can you open a new chrome tab`) completed in **7.95 seconds**, **3 Jev decisions**, and **3 supervisor reviews**. Exactly one creation was proposed. An independent depth-6 native tab inventory increased from **41 to 42**, with the new tab selected. The test's duplicate guard would fail before dispatching a second creation; it is not part of product behavior. No browser debugger or profile was used.
- Unit regressions verify one and two explicitly requested creations, result review before another mutation, read-only verification, non-addressable evidence, existential presence versus unique value predicates, hidden ancestors, window targets and scope-change handling. The action Choice and completion proposal are now mutually exclusive instead of independent questions.
- A Word regression using the new controller created Document7 and entered the body once. It stopped at decision 6 after **12.03 seconds** because OpenAI returned HTTP 429 on the fourth supervisor request. It is **not a successful Word run or a completed latency comparison**; formatting remained unfinished.
- Latest full checks: **226 TypeScript tests / 14 files**, **69 Python tests**, and Swift clipboard/selection/identifier/role self-tests pass. Model transports in unit tests are mocked.

Artifacts: `.runtime/new-tab-ui-smoke.json`, `.runtime/result-checkpoint-tests.log`, `.runtime/word-comparison-sol.json`. The earlier successful Sol Word run is preserved in `.runtime/word-comparison-before-checkpoints-sol.json`. Subsequent tests have not established universal reliability. The production model remains Sol Ultrafast; Noul has been researched but is not part of this patch.

# Latest verification — supervisor and native-only runtime

- TypeScript: **218 tests / 13 files passed**, including modal wrappers without native references, sibling controls despite focused fields, immediate interruption reviews, and suppression of repeated completion reviews over unchanged evidence.
- Python: **68 tests passed**, including authenticated supervisor routes, constrained evidence IDs, optional reasoning/service-tier settings and reused HTTP transport. Provider calls in unit tests are mocked.
- Swift clipboard/selection/identifier/role self-tests and earlier live TextEdit Unicode/paste regressions passed.
- The supervisor initially completed the Word text/size workflow in 16 decisions and 30.45 seconds with Mini. The early oracle checked body text and the toolbar value; it did not independently prove applied text formatting.
- A Luna run cancelled the existing save dialog, created a new document, entered the body once and reached a 24-valued font control. Another Luna run eventually applied 24 pt, independently confirmed by `AXAttributedStringForRange`. It also exposed a popup clipping defect and unnecessary completion reviews. These runs do not establish a speed improvement.
- A later event log exceeded the UI's 150-event ring. Partial durations from that state are not valid whole-task measurements. The comparison harness now records all streamed events and a separate elapsed-time clock.
- Same recorded dialog request, three model-only runs each: Luna/no reasoning **4.320 / 3.036 / 3.841 s** (median **3.841 s**); Sol/low/Ultrafast **2.178 / 2.258 / 2.021 s** (median **2.178 s**). All six plans validated and preserved the existing document by cancelling its prompt. This is one prompt, not a broad benchmark. Spark model lookup returned HTTP 404 for the configured key.
- The new Word oracle reads the actual attributed document text and requires every non-whitespace run to be 24 pt, independently of the editable toolbar field. Live comparison results are recorded separately below.

Model-only artifact: `.runtime/supervisor-model-comparison.json`. Native/UI regression artifacts: `.runtime/supervisor-tests.log`, `supervisor-python-tests.log`, `supervisor-native-smoke.log`, `supervisor-ui-smoke.log`. Per-variant Word results use `.runtime/word-comparison-{none,luna,sol}.json`.

## Word comparisons and current overlay

The paired comparison used the same goal and starting Word window: create a **new** document containing `hello how are you in it`, then apply **24 pt** to that text. Existing documents were protected by the smoke guard. No browser/debugger driver was used. Each row is one trial, not a reliability estimate. Elapsed time covers the task run; the independent formatting oracle runs afterwards.

| Configuration | Controller result | Elapsed | Jev decisions | Supervisor calls | Independent result |
| --- | --- | ---: | ---: | ---: | --- |
| Jev alone | Failed | 4.42 s | 6 | 0 | Attempted to write the existing document; test guard prevented it. |
| Luna, reasoning off | Failed | 30.58 s | 18 | 5 | Created document, exact body once, actual 24 pt. Final supervisor response parsing failed. |
| Sol Ultrafast, low reasoning | Passed | 36.26 s | 34 | 7 | Created document, exact body once, every non-whitespace text run actually 24 pt. |
| Luna repeat, reasoning off | Passed | 147.90 s | 117 | 25 | Created Document6, exact body once, every non-whitespace text run actually 24 pt. Repeated verification reads accounted for much of the delay. |

The repeat used the same controller and prompt as the preceding comparison. Sol remains selected in the application. Luna's earlier parse failure is not counted as a successful controller run even though a separate post-failure read confirmed the requested document. Its raw provider response was not captured, so the exact response-shape cause is unknown.

An earlier round also failed: Jev alone targeted the existing document; Luna timed out after creating a blank document; Sol reported completion in 29.83 s while the independent attributed-text oracle found **12 pt**, despite a 24-valued toolbar field. The subsequent passing runs do not eliminate that structural false-completion risk. See the critical review in architecture.md.

The generic menu/popover clipping fix passed **43 focused Rust tests** and a live Word font-menu probe: option 24 was no longer incorrectly offscreen and became a clickable Jev choice. No application names or font-size values are embedded in the production fix.

The always-on-top overlay passed live checks at 480 px and 400 px widths, in compact and expanded modes, with no horizontal overflow. Two consecutive deterministic TextEdit tasks completed, input became editable after each, and the overlay remained visible without taking focus from TextEdit. All-workspace visibility and the show shortcut were verified through Electron; full-screen application transitions were not exercised. The legacy TextEdit fixture now uses its application-scoped New shortcut instead of attempting to click a closed menu item. General Jev navigation is unchanged by that fixture correction. Screenshots and results: `.runtime/overlay-{compact,expanded}-{400,480}.png`, `.runtime/overlay-ui-smoke.json`.

Latest comparison artifacts: `.runtime/word-comparison-{none,luna,sol}.json`. Luna's preceding trial is preserved as `.runtime/word-comparison-second-luna.json`; the initial failed round is `.runtime/word-comparison-first-{none,luna,sol}.json`. Each records full streamed events and request timings without keys. Popup evidence: `.runtime/popup-visibility-result.json`.

## Historical results (before supervisor integration)

# Verification — 14 November 2026

## Latest native browser tests

- 205 TypeScript tests, 39 Python tests, typechecking and native clipboard/selection/role tests pass. The current code has no confidence cutoffs.
- Chrome was tested through macOS Accessibility in the user's regular browser with `ASSISTANT_BROWSER_DRIVER=native`; no Chrome debugging connection, isolated profile, WebDriver or browser JavaScript was used. Playwright drove only the assistant's Electron UI.
- Full-flow attempts entered `youtube.com`, pasted one verified `rag` search, submitted it and opened named video results. They also exposed traversal loops, pre-paste layout changes, mistaken preview controls, and incorrect/blocked completion. These attempts are not counted as a reliable end-to-end pass.
- Narrow test: results for `rag` were prepared before Jev started. A screenshot recorded the top result as **What is Retrieval-Augmented Generation (RAG)?**, IBM Technology. The goal supplied to Jev named only “the first video at the top,” not that title. The first run clicked the correct named result; fresh AX observations showed Pause and Seek advancing from 13 to 14. The controller nevertheless stopped during semantic completion (10 decisions).
- A repeat scrolled down and selected **What is RAG ? | Completely Explained in 15 Minutes**, a different result. The experimental completion rule accepted playback but did not prove the requested ordinal selection. Independent playback did not advance during that sample either. The test failed. The experiment allowing a DONE proposal to override a contradictory semantic status was reverted; motion alone is insufficient to validate which content was requested.
- Generic changes retained: collapse anonymous layout wrappers while preserving unread/semantic regions; inspect structural/player containers instead of clicking them; preserve action outcomes through long traversal histories; include parent-region context and playback evidence on every sibling page; retain observed bounds in Jev choices for spatial instructions; refresh/replan after a paste failure proven to precede input, without retrying uncertain delivery. Completion diagnostics now expose the evidence check in the live log.
- Remaining: reliable intent/target tracking across navigation and scrolling. Parent context improves visibility but does not itself guarantee correct planning. An LLM supervisor is researched, not implemented. A repeated full-flow pass has not been established.

Artifacts: `.runtime/chrome-native-live-*.log`, `.runtime/chrome-first-video-live.log`, `.runtime/chrome-first-video-live-2.log`, `.runtime/chrome-first-video-before*.png`, `.runtime/chrome-first-video-native-state.json`, `.runtime/chrome-native-tests.log`. Comparison and supervisor research are in `.runtime/controller-comparison/`.

## Earlier native app baseline

The application was rebuilt and restarted with the patched native binary and the simplified instruction/log interface.

- TypeScript: 98 tests passed, including paste eligibility/dispatch, focus loss, unchanged-value checks, cancellation, uncertain delivery, duplicate prevention, scoped focus notices and existing navigation regressions.
- Python broker: 27 tests passed, including the FOCUS_AND_PASTE choice and exact-input contract.
- Native paste helper: isolated clipboard tests passed for multiple items, HTML/text/custom binary/file formats, concurrent user copies, empty clipboard restoration, Unicode selections and paragraph boundaries.
- Native dependency: 1,719 core and 817 macOS library tests passed; one upstream test remains ignored. Secure-field redaction tests pass.
- Real TextEdit: Unicode replacement (`Hello café 😊`), insertion (`!`) and an already-satisfied write passed through the general bridge. A fresh read with the final binary returned `Hello café 😊!`.
- Real Outlook/Jev: one recipient write, explicit selection of the matching address suggestion, one committed recipient token, and continuation into Subject. Fresh native reads independently confirmed `zcabps0@ucl.ac.uk` and `Recipient verification test`. No email was sent.
- The Outlook model run ended blocked at its final completion assessment despite the verified recipient and subject. This is recorded separately from the deterministic field checks; it is not claimed as a fully completed model run.
- Outlook body: live Jev selected the new generic FOCUS_AND_PASTE tool and replaced the body with one exact Unicode text copy. A second scenario started with Subject focused; Jev used Tab and an observed scroll-area focus action, inspected the body, and pasted once. Subject remained unchanged. Two additional requests returned already_satisfied / not_delivered, with fresh reads confirming exactly one body copy. Clipboard content and format hashes matched before and after. All smoke dispatches were constrained to prevent sending; the draft remains unsent.
- The body run still ended blocked at Jev's independent completion assessment. This does not invalidate the exact native body postcondition, but arbitrary task completion remains a separate limitation. The test report preserves both results without reducing the configured confidence thresholds.
- The same FOCUS_AND_PASTE implementation passed multiline Unicode replacement and repeat suppression in TextEdit. Runtime code contains no application-name, bundle-ID or known-layout exceptions; only the smoke fixtures name applications.
- UI: production Electron smoke passed; screenshots at 1080×820 and 640×600 were inspected, with no horizontal overflow.
- Fallow: zero unused-code/dependency/circular-dependency findings after reviewing entry points and the executable agent-desktop dependency.
- Unsigned macOS package rebuilt. SHA-256 checks confirmed its CLI, macOS accessibility helper and focus-and-paste helper match the tested binaries. The development Electron app and authenticated backend were restarted with the new action.

A three-sample read-only comparison on the same Outlook window measured median app window inventory times of 126 ms upstream / 120 ms patched, and shallow snapshot times of 234 ms upstream / 204 ms patched. These measurements predate the paste tool and show no observed regression for the existing accessibility patch; they are not a general performance guarantee. Semantic text actions additionally allow up to 400 ms for an auxiliary window to appear. Paste verifies text and then performs the normal fresh observation; suggestion acceptance remains a separate action.

Detailed logs, snapshots, screenshots and reports are local in `.runtime`. Unsent test drafts and unsaved TextEdit test documents remain available for inspection. The tests do not establish support for every application's custom controls or every natural-language task.

Paste evidence: `.runtime/paste-ui-smoke.json`, `paste-jev-state.json`, `paste-repeat-smoke.json`, `paste-textedit-smoke.json`, `paste-live.log` and `paste-tests.log`. The helper requires a complete readable text range and selection, and replaces the entire field. It stops on unverifiable editors or outcomes; it does not provide arbitrary coordinate typing or app-specific fallbacks.
