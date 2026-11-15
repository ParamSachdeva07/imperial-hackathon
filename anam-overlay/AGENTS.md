# Anam overlay integration rules

This project is a local Electron + React + TypeScript desktop overlay with a Python FastAPI token broker at `http://127.0.0.1:8765`.

## Persona and credentials

- Use the existing saved persona `ec3b8e17-2ff7-517d-92e5-c13a3a865023`. Its avatar, voice, system prompt, knowledge and model are managed in Anam Lab.
- Exchange credentials server-side with `POST https://api.anam.ai/v1/auth/session-token`, sending only `{"personaConfig":{"personaId": configured_id}}`. Do not recreate or override the persona in client code.
- Only Python may load `backend/.env`. Keep `ANAM_API_KEY` server-side. Never request it in chat, print it, commit it, expose it via IPC, prefix it with `VITE_`, or include it in a frontend bundle.
- Never overwrite an existing `.env` or user secret. `.env.example` contains blank credentials. If a key is pasted into chat, advise the user to rotate it and store the replacement locally.
- Session tokens are temporary and must be requested anew for each session. Do not persist tokens in storage or logs.
- Bind Uvicorn to `127.0.0.1`, not `0.0.0.0`. Keep origin/host checks, the custom IPC request header, sanitized failures, no-store responses, and bounded token requests. This is a local app, not a remotely hosted authentication service.

## Sources and dependencies

- Before changing the integration, fetch https://anam.ai/docs/javascript-sdk/quickstart and https://anam.ai/docs/llms.txt, then relevant live reference pages. Report contradictions instead of guessing.
- The quickstart puts an API key in browser code. Follow the server-side authentication and saved-persona flow in https://anam.ai/docs/javascript-sdk/production and the user's explicit server-only credential requirement.
- Check current published versions in npm/PyPI before upgrades. Never guess version numbers. Commit package-lock.json and the Python requirements lock after verification.
- Match SDK event names and signatures to the installed package's declarations.

## Electron and React

- Keep contextIsolation, sandbox and webSecurity enabled; nodeIntegration disabled. Expose only narrow typed preload methods and validate IPC senders. Block new windows and navigation.
- The launcher starts hidden in a 56×56 transparent, click-through native window near the top-right corner. Hovering within 96px of the screen corner (including the menu bar) slides out the existing pale-green dot. Leaving hides it after a 650ms grace period. Hover never starts a session. Clicking expands the avatar and explicitly starts a voice call. Never capture audio while collapsed or request camera access. Keyboard focus/Dock activation must also reveal the launcher.
- Use `createClient(sessionToken)` and `streamToVideoElement`. Do not use an API-key client constructor or override the saved persona.
- Clean up SDK listeners, microphone tracks and streams on end, failure, cancel, unmount and close. Ignore stale async completions and stop connections that finish after cancellation.
- Preserve transparent frameless always-on-top behavior. Resize the native window when expanding/collapsing; on hangup dock back at the current display’s top-right corner and hide unless hovered or keyboard-focused. Never auto-hide an expanded call. Show only the circular avatar and separate mute/end-call buttons during a call. End-call must stop the session and restore the dot, not quit Electron. Keep native resizing disabled; use bounded setBounds calls for expansion and the optional context-menu avatar sizing. Only the expanded portrait is draggable; keep the launcher docked to its corner. Portrait dragging must not activate call controls.
- Preserve the launcher fill `#D7EBBC`; use a simple `#0088FF` avatar border and Apple’s default/light system green `#34C759` and red `#FF383C` for the mute/end controls. Prefer SF Pro/system typography, readable dark glyphs on colored fills, and clear muted-state icons/labels. Respect reduced motion for reveal/expansion.
- Keep loading/error feedback inside the circle, keyboard alternatives, focus visibility and reduced-motion support. Escape ends the call and collapses; restore launcher focus for keyboard actions, while pointer hangup allows it to hide. No transcript panel, text composer or title bar in this compact interface. Video retains the background produced by Anam; transparent window chrome is not video background removal.

## Speak-only exception (`ANAM_SPEAK_ONLY=1`)

When Pointy drives the avatar through the control API, the persona LLM is disabled and the avatar only speaks text sent via `talk()` / talk streams. This is the only exception to "clicking starts a call": a session may also be started by the control API, which is an explicit user action in Pointy (gesture or hotkey). In this mode never capture or request the microphone (`disableInputAudio: true`, permission handlers deny media) and never use `sendUserMessage` or `addContext`. End-call and the 3-minute idle stop still collapse to the dot. Without the env var, none of this code path is reachable and the rules above apply unchanged. Tests must set `ANAM_CONTROL_FILE`/`ANAM_CONTROL_PORT` and never use a paid session.

## Verification and commands

- `npm run build` checks TypeScript and builds Electron plus React.
- `npm test` runs Electron behavior and lifecycle checks using a test-only SDK fixture; never connect these tests to a paid live avatar session.
- `npm run test:backend` verifies token payloads, credential isolation, origin/host rejection, rate limits, and upstream failures with mocked HTTP.
- Backend: `backend/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765` from the project root.
- Frontend: `npm start` for the built app; `npm run dev` for Vite HMR. Restart development after changing Electron/preload code.
- Test a real Anam conversation only when credentials are privately configured; never claim live avatar validation from mock tests.
