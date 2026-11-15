# Desktop Assistant

A macOS app that carries out a typed request on your desktop. Luna, the orchestrator, plans the request and
decides when it is finished. A fast navigator model carries it out one small session at a time, through macOS
accessibility and, for Chrome pages, a local browser extension.

How it works is described in [docs/architecture.md](docs/architecture.md).

## Run

```sh
npm run dev
```

The launcher starts Electron, Vite and an authenticated local broker (Python, FastAPI) that makes the model
calls. Closing the window stops all three. `Start Desktop Assistant.command` does the same.

Put the keys in `services/decision-api/.env` (see `.env.example`) and restart after editing:

```dotenv
NAVIGATOR_PROVIDER=cerebras
CEREBRAS_API_KEY=your_cerebras_key
CEREBRAS_MODEL=qwen-3.8-27b
CEREBRAS_REASONING_EFFORT=low

ORCHESTRATOR_PROVIDER=openai
OPENAI_API_KEY=your_openai_key
ORCHESTRATOR_MODEL=gpt-6-luna
ORCHESTRATOR_REASONING_EFFORT=none
ORCHESTRATOR_SERVICE_TIER=priority
```

Each provider receives only its own key. Keys stay in the broker and are removed from the Electron and
native helper environments. (`SUPERVISOR_PROVIDER` is still read as an older name for `NAVIGATOR_PROVIDER`.)

Grant Accessibility permission to the app that launches the native helper. No microphone, camera or screen
recording permission is used, and no screenshots are sent anywhere.

For a fresh checkout: Node 24 (22.12 or later), Python 3.11+, uv, Rust and the macOS command-line tools, then
`npm ci` and `npm run setup`.

## Chrome extension

Load `extension/page-bridge` in `chrome://extensions` (Developer mode, Load unpacked). With it, pages are read
and operated from inside the browser in milliseconds, a named site opens in one step, and a web search runs
in your default search engine. Without it everything goes through accessibility, which is slower.

After the files in that folder change, press the reload arrow on the extension's card. The app refuses a copy
older than it expects and says so under **Settings and connection**. See
[extension/page-bridge/README.md](extension/page-bridge/README.md) for what the extension can see.

## Use

Type a request and press Send or ⌘ Enter. The overlay stays on top; **Show log** opens the live log.

- Sending a new request while one is running replaces it: the running task is stopped, any action already
  sent is allowed to return, and the new task starts from a fresh look at the screen.
- **Stop** or ⌘ ⇧ . ends the task. An action that was already sent cannot be undone.
- There is no limit on steps, time or sessions. A task runs until Luna finishes it, reports that it cannot
  be done, or you stop it.
- Nothing asks you anything. A request to send, buy or delete something is carried out; there is no
  confirmation step.
- ⌘ ⇧ Space shows the overlay.

A caller such as a voice agent starts a task with `{ goal, context }`. `context` is a short note about what
came before. When the task ends, `completion` holds a summary, the facts it rested on and where the desktop
was left (app, window, address); passing that back as the next `context` links one request to the next.

Every task writes a full trace to `traces/<taskId>.jsonl` under the app's user-data folder (or
`ASSISTANT_TRACE_DIR`). Traces contain screen text and model exchanges and stay on this machine.

## Code layout

```text
apps/desktop/src/                 Overlay: input, live log, connection status
apps/desktop/electron/
  main.ts, preload.ts             Window and restricted IPC
  controller/
    navigation.ts                 One task at a time: start, replace, stop, publish state
    orchestrator.ts               Luna's loop and the memory of one task
    navigator.ts                  One session: observe, one step, check, send once, read the result
    ledger.ts                     Every action sent and what is known about its result
    observation-index.ts          The screen as elements, retrieved by relevance at any depth
    identity.ts, settle.ts, menu-index.ts, url-provenance.ts
  desktop/                        macOS accessibility adapter (agent-desktop) and paste helper
  page/                           Chrome extension bridge: local server, page adapter, routing
  services/decision-client.ts     Authenticated broker client with retries
packages/contracts/src/           Every type that crosses a boundary, defined once
services/decision-api/app/
  orchestrator.py                 Luna's prompt and decision
  navigator.py                    The navigator's prompt and step
  providers.py                    One structured-output call to OpenAI or Cerebras
  schemas.py                      Strict validation of model output
extension/page-bridge/            Chrome extension
native/                           Pinned Rust patch and Swift paste helper
scripts/                          Launcher, native builds, extension end-to-end test, local Wordle fixture
tests/, services/decision-api/tests/
```

## Test and package

```sh
npm test                 # typecheck, unit tests, paste helper, broker tests
npm run test:extension   # the extension in a separate Chromium against a local page
npm run fixture:wordle   # a local game to try a feedback-driven task on
npm run package:mac
```

Tests use scripted models. They check the controller's rules, not how well a live model performs.
Packaged builds are unsigned development apps under `release`.
