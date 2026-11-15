# Merging the execution agent into the voice app

Written 15 November 2026. "The voice app" is the code from the `imperial-hackathon` repository (merged from its `main`, commit
`ba7d3f6`); its name is not decided. "The execution agent" is the code in `execution/`.

Facts about ElevenLabs and Anam below come from their public documentation, read on the date above.
Anything marked **unconfirmed** has to be tested in Phase 0 before work that depends on it starts.

## Status (15 November 2026)

**Decision: the voice agent is GPT Realtime 2.1, spoken through the Anam avatar. ElevenLabs is not used.**
The ElevenLabs stack was built, run once (the call connected and injected notes were spoken) and then
removed at the owner's request; it is in the history at commit `7473a31`. Phases 0 and 3 below are kept
only as a record of that route.

The two repositories are merged in this one: the voice app at the root, the execution agent in
`execution/`. The standalone execution agent is kept as the tag `execution-standalone`, the branch
`execution-standalone-branch`, and a copy in `~/Documents/personal-assistant`.

**How the voice agent works now**

- Model: `gpt-realtime-2.1` (was the mini), reasoning effort `low`, text out. `POINTY_REALTIME_MODEL`
  and `POINTY_REASONING_EFFORT` override both.
- Speech: Anam speaks the text, sentence by sentence. Interruption is the existing barge-in guard.
- Tools, registered with the Realtime session like any agent's tool list: the eleven drawing tools
  and the three execution tools (`run_on_computer`, `stop_computer_task`, `computer_task_status`).
- Context: the live conversation; each turn's screenshot and control list, with older images removed;
  a rolling 20-minute memory re-injected when a session reopens; and every finished task as an
  "[execution]" note, which is how one execution call can build on the last.
- Execution is asynchronous: the tool returns at once, the task runs in the execution service, and
  the outcome is spoken when it ends, at a quiet moment.
- One start command, `npm run pointy`, launches the avatar, the voice app and the execution service.

**Verified**

- Unit tests across all four parts.
- `gpt-realtime-2.1` is available to the configured key.

**Not verified**

- A task started by voice while the conversation continues. Nothing on this stack has been spoken
  to since the execution tool was added.
- Camera and Screen Recording must be granted to the app that launches it (Terminal); they cannot be
  granted when it is launched from a Claude session.

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
