# Pointy

A voice assistant for macOS that can see your screen, show you where things are, and do tasks for you.

You talk to it like a person. It answers out loud through an on-screen avatar, draws on top of your real
desktop to show what it means (arrows, highlights, numbered steps, short explainer cards), and can take over
the mouse and keyboard to carry out a request. You can also point at things with your hand in front of the
camera instead of using the mouse.

It is built for people who find computers hard to follow: instead of describing where a button is, Pointy
points at it.

## What it does

- **Talks and listens.** A live speech-to-speech session (OpenAI Realtime over WebRTC). You can interrupt it
  mid-sentence.
- **Sees the screen.** Each question is answered with a current screenshot and the names and positions of the
  controls on screen (read through macOS accessibility).
- **Draws on the desktop.** A click-through overlay that points at, highlights and labels real controls, walks
  through steps and shows explainer cards.
- **Acts for you.** A separate execution agent plans a task and carries it out through accessibility and, in
  Chrome, a small browser extension.
- **Understands hand gestures.** Raise an open palm to start; one finger moves the mouse; two fingers drag a
  rectangle around the area you want to ask about.
- **Shows a face.** A lip-synced avatar (Synthesia, or Anam) in a small round window in the corner.

## How it is put together

```text
apps/desktop/      The app: voice session, overlay, gestures, screen capture, tray
packages/shared/   The overlay tool contract (schemas) shared by the app and its tools
packages/gestures/ Camera hand tracking (MediaPipe) turned into gesture events
anam-overlay/      The avatar window and its local token service (Python, FastAPI)
execution/         The execution agent: planner (Luna), navigator, Chrome extension
native/ax-helper/  Swift helper that reads on-screen controls through accessibility
backend/, assets/  Optional explainer pictures (off by default)
tools/pointy-draw/ Command-line tool for drawing overlays by hand while developing
scripts/pointy.mjs One command that starts everything
```

`npm run pointy` starts four things and stops them together: the avatar's token service, the avatar window,
the execution agent, and the app itself.

More detail: [the overlay](apps/desktop/src/main/overlay/README.md), [gestures](packages/gestures/README.md),
[the avatar window](anam-overlay/README.md), [the execution agent](execution/README.md) and
[its architecture](execution/docs/architecture.md).

## Setup

Needs macOS, Node 22.12 or later, Python 3.11 or later, [uv](https://docs.astral.sh/uv/), Rust and the Xcode
command-line tools.

```bash
# The app
npm install
npm run gestures:assets

# The avatar window
cd anam-overlay
npm ci
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cp -n backend/.env.example backend/.env
cd ..

# The execution agent
cd execution
npm ci
npm run setup
cd ..
```

Then add your keys. None of these files is committed.

| File | Keys |
| --- | --- |
| `.env` | `OPENAI_API_KEY` (voice) |
| `anam-overlay/backend/.env` | `SYNTHESIA_API_KEY`, `SYNTHESIA_AVATAR_ID`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, or `ANAM_API_KEY` for the Anam avatar |
| `execution/services/decision-api/.env` | `OPENAI_API_KEY` (planner), `CEREBRAS_API_KEY` (navigator) |

For faster and more reliable work in Chrome, load the extension: open `chrome://extensions`, turn on Developer
mode, choose "Load unpacked" and pick `execution/extension/page-bridge`.

## Run

```bash
npm run pointy
```

The launcher checks the setup first and says what is missing. macOS will ask for Microphone, Camera, Screen
Recording and Accessibility permission for the terminal you start it from.

Start a call with Cmd+Option+P, by moving the cursor into the top-right corner and clicking the green button,
or by raising an open palm to the camera.

```bash
npm run pointy -- --check     # check the setup only
npm run pointy -- --no-anam   # run without the avatar
npm run pointy -- --debug     # also show the camera preview and start the developer server
```

## Tests

```bash
npm test
npm run typecheck
```

The execution agent and the avatar window have their own tests: run `npm test` inside `execution/` and
`anam-overlay/`.
