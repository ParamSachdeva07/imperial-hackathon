# Merging the execution agent into the voice app

Written 15 November 2026. "The voice app" is the code from the `imperial-hackathon` repository (merged from its `main`, commit
`ba7d3f6`); its name is not decided. "The execution agent" is the code in `execution/`.

Facts about ElevenLabs and Anam below come from their public documentation, read on the date above.
Anything marked **unconfirmed** has to be tested in Phase 0 before work that depends on it starts.

## Status (15 November 2026)

The two repositories are merged in this one: the voice app at the root, the execution agent in
`execution/`. The standalone execution agent is kept as the tag `execution-standalone`, the branch
`execution-standalone-branch`, and a copy in `~/Documents/personal-assistant`.

**Done and tested**

- Phase 1: the headless execution service (`npm run serve` in `execution/`). It boots, checks the
  token and answers `/state`; a full task through it has not been run.
- Phase 2: the asynchronous execution tool on the current OpenAI Realtime stack. `run_on_computer`
  returns at once, the result is announced when it ends, a new request replaces the running task, the
  assistant stays open while a task runs, drawings are cleared and the hand stops driving the mouse.
  Unit-tested with fakes; **not yet run by voice.**
- ElevenLabs agent definition: `scripts/elevenlabs-agent.ts` builds the agent with GPT-6.1 Sol on the
  fast service tier, low reasoning, PCM 16000 Hz input and all twelve tools as client tools.
  `--print` works; **creating the agent has not been run** (no ElevenLabs key on this machine).
- Avatar backend: with `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` and `ANAM_AVATAR_ID` set, the
  session token is created for that ElevenLabs agent on a Cara 4 avatar. Tested with fake upstreams.

- Agent mode, both apps (`POINTY_VOICE_STACK=elevenlabs`): the avatar app turns the microphone on,
  registers a handler per tool with the Anam SDK and forwards each call to the main app's tool bridge;
  the main app runs the tool (drawing, execution, or `look_at_screen`, which returns today's
  "[screen]" text) and a small session class replaces the Realtime controller for opening, closing,
  idle, gestures and menu-bar status. Typechecked and unit-tested; **never run against Anam.**
- One start command: `npm run pointy` also launches the execution service, and picks the avatar's
  mode from `POINTY_VOICE_STACK`.

**Still to do, all of it needing real keys**

1. Run `scripts/elevenlabs-agent.ts` to create the agent, and put its id, the ElevenLabs key and a
   Cara 4 avatar id in `anam-overlay/backend/.env`. The API paths in the script are from the
   documentation and have not been called.
2. Phase 0's questions, now concrete:
   - Does `sendUserMessage` reach the ElevenLabs agent? Announcing a finished task in agent mode is
     built on it (`POST /message` on the avatar app). If it does not, the result is still returned
     by `computer_task_status`.
   - Does the avatar's own voice trigger the agent on laptop speakers? Interruption is ElevenLabs'.
   - Can an image reach the agent? Until then the agent gets the control list as text, no picture.
3. The spoken offer right after a selection is not built in agent mode. The selection is included
   the next time the agent calls `look_at_screen`.
4. Try it by voice on both stacks. Nothing here has been spoken to yet.

## Target shape

```
You (voice, finger, selection)
  └─ Voice agent        ElevenLabs agent, spoken through an Anam avatar
       │  remembers the conversation and the result of every execution call
       │  decides whether to act and what earlier context to pass down
       └─ Execution tool   one call = one task for Luna        (this repository)
            │  remembers every navigator session of this task
            └─ Navigator   one session = one small objective on the screen
```

- The voice agent only talks, draws and delegates. It never clicks.
- An execution call runs in the background; the conversation carries on while it works.
- Context builds upward: sessions report to Luna, Luna's result reports to the voice agent, and the
  voice agent chooses what to pass into the next execution call.
- Nothing about navigator sessions crosses from one execution call to the next.

## What exists today in the voice app

- **Conversation:** OpenAI Realtime (`gpt-realtime-2.1-mini`), text out, in a hidden window. The
  1,466-line `AssistantController` is written around Realtime's conversation items.
- **Speech:** the separate `anam-overlay` app, driven as a mouth: the voice app sends it text.
- **Screen:** per turn, one screenshot plus up to 150 accessibility elements as text, with a pointer line
  when the finger moved the pointer in the last 10 seconds.
- **Selection:** two images and an "[offer]" note; the model replies with one spoken question.
- **Tools:** eleven overlay drawing tools. The instructions say it cannot click or type.
- **Memory:** the live conversation, plus a rolling 20-minute, 6,000-character record.

## Phase 0 — Four questions to answer first

Each is a short experiment with a throwaway ElevenLabs agent and the Anam JavaScript SDK. The answers
decide the design of Phase 3.

1. **Can the app add context to a live conversation?** Anam's SDK documents `sendUserMessage()` and a
   context message type. **Unconfirmed:** that either reaches the ElevenLabs agent when the session is
   backed by one.
2. **Can the app make the agent speak unprompted?** Needed for "I see you selected this" and for
   announcing a finished task. Likely the same mechanism as question 1.
3. **Can the agent see an image mid-conversation?** ElevenLabs documents file input and an "upload
   conversation file" API. **Unconfirmed:** how to reach the conversation id through Anam.
4. **Plan and avatar.** The integration needs a Cara 4 avatar. Confirm the Anam plan in use includes
   it and the ElevenLabs integration, and that the ElevenLabs plan includes agents.

If 1 and 2 fail, use the fallback in Phase 3. If 3 fails, images go through a tool (Phase 3, "Seeing").

## Phase 1 — Run the execution agent headless (this repository)

The voice app must be able to start, replace, stop and watch a task without the overlay window.

- Add a small local service that composes the existing pieces: broker, desktop adapter, page bridge,
  `NavigationController`. No Electron window.
- Loopback only, with a random token written to a file the voice app reads (the same pattern the
  voice app already uses for the Anam control server).

| Call | Purpose |
|---|---|
| `POST /task` `{ goal, context }` | Start a task. If one is running, it is replaced. Returns `{ taskId }` at once. |
| `POST /stop` | Stop the running task. |
| `GET /state` | Current status, plan, step count. |
| `GET /events` (stream) | Status changes, Luna's decisions, the final result. |

- **Result of a task,** sent on the stream and returned by `/state`:
  `{ taskId, status, summary, facts, location, plan }` where `status` is completed,
  completed_unverified, blocked, cancelled or failed.
- The overlay app in this repository stays as a development front end on the same service.
- Tests: the service starts a scripted task, replaces it, stops it, and reports each ending.

**Done when** `curl` can run "open twitch.tv" and receive the result on the event stream.

## Phase 2 — The execution tool, on today's voice stack

Do this before changing the voice stack. It works with OpenAI Realtime as it is, so the tool, its
asynchronous behaviour and the context pyramid can be proven independently of ElevenLabs.

**Tools added to the voice agent**

| Tool | Arguments | Returns |
|---|---|---|
| `run_on_computer` | `request` (what to do, in plain words), `context` (anything from earlier in the conversation that matters; may be empty) | At once: `{ started: true, taskId }` |
| `stop_computer_task` | none | `{ stopped: true }` |
| `computer_task_status` | none | The current state, for "how is it going?" |

**Flow**

1. The agent calls `run_on_computer`. The app posts the task and returns "started" immediately, so the
   agent can say "I'm on it" and keep listening.
2. While it runs, the app shows a small status in the tray or overlay. Speech is not interrupted.
3. On the final event the app adds an "[execution]" message to the conversation with status, summary,
   facts and location, and asks the agent to respond, so the avatar reports the outcome.
4. If the user is speaking at that moment, the message is added and the announcement waits for the
   end of the turn.

**The context pyramid**

- The voice agent fills `context` itself. Its conversation already holds every earlier "[execution]"
  message, so it can pass what is relevant and omit what is not. No code decides relevance.
- When the user refers to the pointer or a selection ("click this", "send that one"), the instructions
  tell the agent to put what is there into `request` or `context`: the control's label and position
  from the pointer line, or a short description of the selection.
- Each "[execution]" message is also written to the rolling memory, so it survives a session reopening.
- Failures are reported like successes. A blocked or unverified result is context for the next call.

**Keeping the two halves in step**

- **One task at a time.** A new `run_on_computer` replaces the running task. The agent is told this.
- **The mouse is shared.** Gestures move the real pointer. Pause mouse-driving gestures while a task
  runs; keep the open-hand "stop" gesture and map it to `stop_computer_task`.
- **Drawings.** Clear overlay drawings when a task starts, so the execution agent does not read them
  as part of the screen, and skip drawing tools that use coordinates until it ends.
- **Stopping.** "Stop", the hotkey, closing the assistant and the stop gesture all end the task.
- **Instructions.** Replace "You can only draw and speak" with: you can show, and you can do things on
  the computer with `run_on_computer`; do things only when asked to; say what you are about to do in a
  few words. There is no confirmation step, so the agent's understanding of the request is the only
  check before something is sent or bought.

**Done when**, by voice: "open YouTube and search for lofi beats" runs while the conversation
continues, the outcome is spoken, and "now open the second result" passes the right context.

## Phase 3 — ElevenLabs through Anam

Anam's server-side integration runs the whole voice loop: its engine connects to an ElevenLabs agent
(speech recognition, the language model chosen in the agent's settings, text-to-speech) and renders
the avatar. Tool calls are forwarded to handlers in the app.

**ElevenLabs agent (dashboard or their CLI, kept as files in the voice app's repository)**

- Voice: V3 Conversational, which enables expressive mode. Anam maps its emotion tags to the avatar.
- Language model: a high-intelligence model with image input, as ElevenLabs recommends for tool use.
  Anam's guide warns that reasoning models add delay; measure before choosing.
- User input audio: PCM 16000 Hz (the only format Anam supports here).
- Tools: every tool as a **client** tool with "wait for response" on: the eleven drawing tools and the
  three from Phase 2.
- System prompt: today's instructions, edited as in Phase 2.

**`anam-overlay` (the avatar app)**

- Session token route (`backend/main.py`): fetch an ElevenLabs signed URL and create the Anam session
  with `elevenLabsAgentSettings`, a Cara 4 avatar and `avatarModel: "cara-4"`.
- Renderer: turn the microphone on (it is off in speak-only mode) and register a handler per tool that
  forwards the call to the main app over the existing control channel and returns its result.
- Forward transcript and interruption events to the main app, for memory and status.

**Main app: replace the Realtime-specific half of `AssistantController`**

| Keep | Remove |
|---|---|
| Screen context builder, pointer line, selection capture | Realtime transport, secret minting, hidden window |
| Overlay tool handling, drawing budget, stale-coordinate check | Sentence batching and text-to-Anam talk |
| Execution tool from Phase 2 | Echo detection, barge-in guard, microphone gating |
| Open, close and idle lifecycle; rolling memory | Conversation-item bookkeeping (image deletion, stubs) |

Anam and ElevenLabs own turn-taking and interruption from here on.

**Seeing the screen**

- If Phase 0 question 1 passes: at the start of each user turn, inject the element list and pointer
  line as context, as today but text only.
- Otherwise: a client tool `look_at_screen` returns that text when the agent asks for it. Slower by
  one tool call, but it needs nothing from Anam.
- Images, if question 3 passes: upload the screenshot or selection images to the conversation.
- Images, otherwise: `look_at_screen` takes a `question`; the app sends the screenshot or selection
  close-up to a vision model and returns a text description. The voice agent never needs the image.

**Selection offer**

- If question 2 passes: on a selection, send the "[offer]" text so the agent speaks its one-sentence
  question, with the selection described by the vision call above.
- Otherwise: the outline stays on screen and the agent uses the selection when the user next speaks.

**Execution results**

- If question 2 passes: inject the "[execution]" message and trigger a reply, as in Phase 2.
- Otherwise: the avatar app speaks a short fixed line ("That's done") and the full result is returned
  the next time the agent calls `computer_task_status`, which the prompt tells it to do when asked.

**Done when** the Phase 2 acceptance test passes on the new stack, and a selection produces a spoken
offer.

## Phase 4 — Clean up

- Delete the Realtime transport, the hidden assistant window, the dev voice window and their tests.
- One start command launches the avatar app, the main app and the execution service, and checks
  permissions for both native helpers (the voice app's accessibility helper and this repository's).
- Update the voice app's integration record and this repository's README.

## Order

Phase 0 and Phase 1 can run in parallel. Phase 2 needs Phase 1. Phase 3 needs Phase 0's answers and
is easier after Phase 2. Phase 4 is last.

## Risks

- **Message injection through Anam is unconfirmed.** It decides whether the selection offer and the
  spoken task result work as they do today. The fallbacks above keep everything else working.
- **No confirmation before irreversible actions.** A misheard request is carried out. This is the
  owner's decision; the mitigation is the agent saying what it is about to do.
- **Two accessibility helpers.** Each needs its own macOS permission, and both read the same apps.
- **Speed.** The voice loop becomes a three-stage pipeline with a model of your choice. Measure the
  delay to first word against today's before removing the Realtime path.
- **Execution reliability.** Keys are still ignored by some apps and closed-menu commands are refused
  by the helper. Voice makes these failures more visible, not less.
