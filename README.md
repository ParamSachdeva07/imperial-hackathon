# Pointy

A voice assistant for macOS that sees your screen, shows you where things are, and does tasks for you.

## Problem

More and more of everyday life now happens only on a screen: applying for housing support, booking a doctor,
paying a bill, sending a document to a council or a bank. For many people, especially older adults and anyone
who did not grow up with computers, these tasks are where things go wrong. The page is crowded, the wording
is unfamiliar, the right button is hard to find, and a mistake can mean a missed payment or a rejected
application.

The help available today does not fit the way these people get stuck:

- **Written guides and help pages** describe a screen in words ("click the paperclip icon in the top
  toolbar"). The person still has to find that thing on their own, different-looking screen.
- **Chat assistants** live in their own window. You have to describe what you see, read a long answer, then
  switch back and carry it out from memory.
- **Phone support and family members** work well, but they are not there at the moment you need them, and
  asking again and again is embarrassing.
- **Automation tools** do the task for you without showing anything, so you learn nothing and cannot tell
  whether to trust what happened.

What people actually ask for is simple: someone sitting next to them who can look at the same screen, point
at the right place, explain it in plain words, and take over when asked.

## Solution

Pointy is that person, on your own computer.

- **You talk, it talks back.** No typing and no chat window. You can interrupt it mid-sentence, as you would
  a person.
- **It sees what you see.** Every answer is about the screen in front of you right now, not a generic
  description.
- **It points instead of describing.** Pointy draws on top of your real desktop: an arrow at the button, a
  highlight around the field, numbered steps, a short card that explains an unfamiliar term. Nothing it draws
  gets in the way of clicking.
- **You can point back.** Hold two fingers up to the camera and drag a box around anything on screen to ask
  "what is this?". One finger moves the mouse, so the keyboard and trackpad are optional.
- **It does the task when you ask.** "Open the form and attach my tenancy agreement" is carried out for you
  with the real mouse and keyboard, and Pointy tells you what it did.
- **It has a face.** A lip-synced avatar in the corner of the screen makes it feel like talking to someone,
  not to a program.

The person stays in control throughout: Pointy shows first, and acts only when asked.

## Architecture and implementation

Pointy is four local programs that start together with one command.

```text
                 microphone / speaker            camera
                        │                          │
                        ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│  The app (apps/desktop, Electron)                            │
│                                                              │
│   Voice session ── screen context ── overlay ── gestures     │
│        │                                                     │
└────────┼───────────────────┬──────────────────────┬──────────┘
         │                   │                      │
         ▼                   ▼                      ▼
   OpenAI Realtime     Avatar window          Execution agent
   (speech to speech)  (anam-overlay)         (execution)
                       Synthesia + LiveKit    planner + navigator
                                              + Chrome extension
```

### Voice

- A live speech-to-speech session with OpenAI's Realtime model over WebRTC, held in a hidden window so the
  microphone and the reply share one audio pipeline and echo cancellation works.
- A small state machine (`AssistantController`) decides when a turn starts and ends, lets the user talk over
  an answer, and greets the user when a call opens.
- The model is given tools rather than free text for anything visual: the overlay drawing tools, a tool to
  hand a task to the execution agent, and a tool to end the call.

### Seeing the screen

- Each turn is sent with a screenshot and a list of the controls on screen with their names and positions.
- The controls come from macOS accessibility, read by a small Swift helper (`native/ax-helper`). This is what
  lets Pointy point at "the Attach button" exactly instead of guessing from pixels.
- A gesture selection is sent as two pictures: the full screen with the selected area marked, and a close-up.

### Drawing on the desktop

- A transparent, click-through, always-on-top window covers each display. It is excluded from screenshots, so
  the model never sees its own drawings.
- The drawing tools (point, highlight, label, steps, explainer and verdict cards) are defined once as schemas
  in `packages/shared` and exported to the model as tool definitions.
- A layout engine places labels and cards so they do not cover the thing they describe, the avatar, or each
  other, and keeps marks attached to their target when the page scrolls.

### Hand gestures

- `packages/gestures` runs MediaPipe hand tracking on the camera and turns landmarks into events: open palm
  to start a call, one finger to move the mouse and dwell to click, two fingers to drag a selection rectangle,
  a fist to scroll.
- The interpreter is plain TypeScript with no camera or browser dependency, so it is tested on synthetic hand
  paths.
- The user's own cursor and selection are drawn in a separate feedback window from the assistant's overlay.

### Avatar

- `anam-overlay` is a small round window in the corner of the screen with its own local token service
  (Python, FastAPI) that keeps the keys out of the app.
- The avatar is a Synthesia interactive avatar rendered into a LiveKit room. The app streams the model's
  voice to it, and the avatar sends back video with matching audio, which is the voice the user hears.
- An Anam avatar can be used instead by setting only the Anam key.

### Doing tasks

- `execution` runs as a local service with two models. **Luna**, the planner, breaks a request into small
  sessions and decides when the task is finished. A fast **navigator** model carries out each session one
  action at a time and checks the result of every action.
- Actions go through macOS accessibility. For web pages, a Chrome extension
  (`execution/extension/page-bridge`) reads and operates the page from inside the browser, which is faster and
  more reliable.
- Each task is told how the previous one ended (app, window, address), so "now send it" continues where the
  last request stopped.
- More detail: [execution/docs/architecture.md](execution/docs/architecture.md).

### Repository layout

```text
apps/desktop/      The app: voice session, overlay, gestures, screen capture, tray
packages/shared/   The overlay tool contract (schemas) shared by the app and its tools
packages/gestures/ Camera hand tracking (MediaPipe) turned into gesture events
anam-overlay/      The avatar window and its local token service (Python, FastAPI)
execution/         The execution agent: planner (Luna), navigator, Chrome extension
native/ax-helper/  Swift helper that reads on-screen controls through accessibility
scripts/pointy.mjs One command that starts everything
```

Component notes: [overlay](apps/desktop/src/main/overlay/README.md), [gestures](packages/gestures/README.md),
[avatar window](anam-overlay/README.md), [execution agent](execution/README.md).

### Setup

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

### Run

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

### Tests

```bash
npm test
npm run typecheck
```

The execution agent and the avatar window have their own tests: run `npm test` inside `execution/` and
`anam-overlay/`.
