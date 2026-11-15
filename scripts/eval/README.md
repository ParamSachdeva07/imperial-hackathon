# Evaluation harness

Judges the controllers on repeated, independently checked workflows (docs/controller-redesign.md, section 11).

```sh
npm run eval -- --list                                  # tasks, start states and arms
npm run eval -- --dry-run --arm current,a,b             # the matrix, without starting anything
npm run eval -- --task chrome-new-tab --arm current,a,b --trials 10
npm run eval -- --summarize .runtime/eval/<run>/results.jsonl --baseline current --candidate a
npm run eval:replay -- --trace .runtime/eval/<run>/traces
```

Arms: `current` is the supervisor plus Jev controller; `a` is the planner alone; `b` is the planner with Jev choosing the target.

**A live run takes over the desktop.** It opens tabs, creates unsaved documents and presses keys in Chrome, Calculator and Word, and it spends model quota. Run it when you are not using the machine. The app that launches it needs Accessibility permission. A proxy between the app and the broker stops any action outside a task's scope before it is dispatched, and no task sends mail, saves or deletes anything.

Results are appended to `.runtime/eval/<run>/results.jsonl`, with a full trace per task under `traces/`. Success is decided by each task's oracle (an independent native read), not by the controller's final status. Ten trials separate only large differences; the summary prints a 95% interval for that reason.

Not in the suite yet: Outlook draft, video playback, a real save sheet, interrupt and replace, and an already-satisfied task. `scripts/outlook-send-ui-smoke.mjs` and `scripts/desktop-ui-smoke.mjs` hold the oracles to port.

## Local Wordle interaction benchmark

Run `node scripts/eval/wordle.mjs` on macOS and open the printed loopback URL in Chrome. The hidden answer stays on the server; only submitted guesses and feedback reach the page. Six guesses, dictionary validation and duplicate-letter scoring are enforced by the fixture. Put the local game in the active tab of the focused Chrome window before starting: the extension reads the active tab, not an arbitrary background tab. Give the app the exact local URL and ask it to choose its own guesses. This tests a controlled accessible page, not NYT’s live interface. Stop and new-prompt interruption remain available.
