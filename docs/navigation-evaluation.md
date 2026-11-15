# Navigation evaluation — 15 November 2026

## Scope and method

Two modes share the same controller, execution adapters, validation and Cerebras `gpt-oss-120b` planner with low reasoning:

- **Planner targets:** the planner chooses the operation, argument and target.
- **Jev targets:** the planner chooses the operation and argument; Jev `jev-1.14.0` selects among compatible observed targets when there is more than one.

The orchestrated version adds bounded navigation sessions above either mode. It uses the same Cerebras model for the coordinator. It is not a larger model by default. The controller keeps one task ledger between sessions; each boundary includes a structured return and fresh observation.

Timing includes model calls, local reads, execution and verification, but excludes process startup and extension reconnection. Costs below use successful provider responses' actual token usage and published list rates: Cerebras $0.35/M input and $0.75/M output; Jev $0.042/M input with free output. These are estimates, not invoices. Missing usage from failed responses is unknown, not zero. Cached tokens are recorded without assuming a billing discount. Sources: [Cerebras pricing](https://www.cerebras.ai/pricing), [TypeSafe models](https://docs.typesafe.ai/models).

## Controlled web trials

The fixture suite uses the real extension, page adapter and live models in an isolated test browser. It does not operate the user's profile. Four tasks cover search submission, identical button labels under different parents, opening a settings menu and applying an input value. Each is repeated three times per mode, with mode order alternating between trials. Independent DOM checks require the requested result, exactly one requested effect, and no effect on the wrong target.

| Version / target selection | Correct effect | Correct effect and controller completed | Mean time | Median time | Mean estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Navigator only / planner | 12/12 | 6/12 | 2.74 s | 2.25 s | $0.00762 |
| Navigator only / Jev | 11/12 | 8/12 | 3.69 s | 2.61 s | $0.00805 |
| Orchestrated / planner | 11/12 | 9/12 | 5.71 s | 4.36 s | $0.01584 |
| Orchestrated / Jev | 12/12 | 9/12 | 5.76 s | 3.64 s | $0.01514 |

Navigator-only artifacts: `.runtime/eval/target-selection-2026-11-15T01-16-44-462Z`. Orchestrated artifacts: `.runtime/eval/target-selection-2026-11-15T01-40-27-198Z`.

The two version batches ran at different development checkpoints, so they are not a controlled measure of the overhead of adding orchestration alone. Within each batch the two target-selection modes share the same implementation. Twelve trials per mode cannot establish equivalent reliability.

The orchestrated planner mode had one duplicate Apply despite reaching the correct final value and reporting completion. Its trace showed that the model refuted the first successful click by citing the unchanged Apply button. The final code now rejects that unsupported refutation, with a regression covering that exact generic failure class. That correction is **after** this table; the table is not represented as a benchmark of that correction. Several trials also reached the correct state but exhausted decisions while verifying. The coordinator improves continuity, but does not by itself guarantee correct interpretation or termination.

After that correction, an additional paired smoke run (`target-selection-2026-11-15T01-47-24-241Z`) produced the correct effect exactly once in **8/8 trials**. The planner-targeted duplicate-label task still ended blocked after doing the right action; the other seven ended completed. This validates the retry correction on the fixtures without hiding the remaining termination weakness. It is only one trial per task/mode.

## Real desktop trials

Regular Chrome uses the user's existing profile and the content-script extension, with native accessibility for browser chrome. Remote debugging is not used. Word uses native accessibility and the generic focus-and-paste helper. Both target-selection modes receive identical task text. The Word oracle reads attributed document text rather than accepting the editable font-size field as proof.

At the earlier `2026-11-15T01-33-18-736Z` checkpoint, both modes opened exactly one Chrome tab: planner targeting took 14.3 seconds and returned `needs_user`; Jev targeting took 10.0 seconds and returned `completed`. The planner-targeted Word run entered the exact text but could not reliably apply/verify formatting and continued verification until its budget. The Jev-targeted Word run tried to write into an existing document and the evaluation guard stopped it. These are failures, not passes hidden by the test harness.

The next desktop batch (`2026-11-15T01-43-00-173Z`) repeatedly failed to resolve Word's focused window. Computer Use then explicitly reported that the Mac was locked. Those launch timings are **invalid as model-comparison results** and are excluded. The batch was stopped before the YouTube/Chrome pairs. The exact lock time is unknown, so no successful unlocked-desktop verification is claimed for that checkpoint. Finishing the paired desktop checks and reloading extension version 0.2.2 requires the user to unlock the Mac.

## Generic corrections and remaining limits

- Typed session handoffs separate completed requirements, remaining work, uncertain delivery and unverified outcomes. They include the app/window/scope, failed validations and attempted inspection routes. Old unresolved effects are retained ahead of recent resolved history.
- The page TYPE receipt now includes the expected value computed before dispatch from the existing text and selection. A page handler that transforms the input leaves verification unsuccessful. The live extension test covers selected-text replacement and transformed input.
- SPA settlement waits for body changes when the URL changes first. Across native windows, global window inventory deltas are retained without comparing unrelated child controls.
- Focused native editors that report AX disabled state may offer the existing generic focus-and-paste tool. Its live-focus checks remain in place; ordinary disabled controls do not gain actions.
- An unchanged screen is not evidence of failure. An unchanged action button is not evidence that its effect failed. An earlier successful field write does not prohibit setting that field again if a fresh observation shows its value changed.
- If launching an app has uncertain delivery, recovery inspects the requested app's window inventory rather than losing that context and returning to the old inventory. This does not bypass a locked desktop.
- A parent can return delivered-but-unverified work explicitly, rather than resetting it or mislabeling it as success. Verified completion still requires accepted evidence for all declared requirements.

No action-confidence thresholds or site/application-specific navigation sequences were added. Model-generated requirements, semantic evidence interpretation, native selection and attributed-text visibility remain limitations. Passing a contract test does not establish reliability in every application.

## Regression checks

380 TypeScript tests and 114 Python tests pass; TypeScript typechecking and the production build pass. The live extension suite passes, including 1,826-element reads, deep list retrieval, action receipts, stale/focus handling and media facts. On that run, median page read time was 29.7 ms; these adapter timings exclude model inference and do not describe whole-task latency.
