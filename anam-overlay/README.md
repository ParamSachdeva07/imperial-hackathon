# Anam desktop overlay

A hidden launcher in the top-right corner of your screen. Move your cursor into the corner and the pale-green button slides into view. Click it to expand your existing Anam persona into a circular video call, with separate mute and end-call buttons. The overlay is transparent, frameless and always on top. Voice, avatar, prompt and knowledge remain editable in Anam Lab.

## First-time setup

Requires Node.js 22.12+ (or a current compatible release), Python 3.10+, and internet access for Anam. This installation was built with Node 24 and Python 3.12.

Run the commands below from the directory containing this README. In the `imperial-hackathon` repository, first run `cd anam-overlay`. This app has its own dependencies and runs separately from the repository's other applications.

```bash
npm ci
node node_modules/electron/install.js
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
# Only if backend/.env does not exist:
cp -n backend/.env.example backend/.env
npm run build
```

Put your API key in `backend/.env` locally:

```ini
ANAM_API_BASE=https://api.anam.ai
ANAM_PERSONA_ID=ec3b8e17-2ff7-517d-92e5-c13a3a865023
ANAM_API_KEY=
```

Keep the real key out of chat, source control and all frontend environment variables. Keep your existing private `.env`; the example file contains a blank key. Python rereads it for each new token request; saving the file is enough.

## Launch

Open both terminals in the directory containing this README. In terminal 1:

```bash
backend/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765
```

In terminal 2:

```bash
npm start
```

Move your cursor to the **top-right corner** (including the menu-bar area). The pale-green launcher slides out; click it to start a voice call. It hides 650ms after you move away, with a generous hover area so you can reach the button. Hovering alone never enables the microphone. The hidden native window passes clicks through to other applications.

Allow microphone access when prompted. The green **Mute / Unmute** control toggles your microphone. The red **End call** control stops the session, returns the launcher to the top-right corner and hides it when your cursor is away. An active call stays open when you move the cursor away. Escape also ends the call and restores keyboard focus to the launcher.

The native launcher window is 56×56 pixels, with the existing 22px pale-green dot and a 44px click target. The circular call view defaults to 320×400 pixels. Drag the expanded portrait to move it; Alt+arrow keys move the call window (Shift for larger steps). Right-click for **Larger avatar**, **Smaller avatar**, or **Quit Anam**. Alt+plus/minus adjusts avatar size. Activating Anam from the Dock or focusing the launcher with the keyboard reveals it without hovering.

The avatar uses a simple blue ring (`#0088FF`). Call controls use Apple’s current default/light system green (`#34C759`) and red (`#FF383C`), with SF Pro/system typography and dark icons/labels for contrast. The launcher retains `#D7EBBC`. [Apple’s current color specifications](https://developer.apple.com/design/human-interface-guidelines/color.md) publish RGB values; these are their hexadecimal equivalents. Reveal and expansion respect reduced-motion settings.

The call view contains just the circular video and the two call controls. Loading and retry messages appear inside the circle. The former transcript panel, text composer and window header are removed.

## Development

```bash
npm run dev
```

`npm run dev` runs Vite at `127.0.0.1:5173` and opens Electron. FastAPI runs separately. React/CSS changes reload automatically; restart after Electron/preload changes. `npm start` loads the production files from `dist/` and `dist-electron/`; it does not start FastAPI. This is a locally launched desktop app; a signed installer is not included.

## Checks

```bash
npm run build
npm run test:backend
npm test
```

Backend tests mock Anam to verify the saved-persona payload, error handling and credential isolation. Electron tests use a test-only SDK fixture and never request a real microphone or paid avatar session. Screenshots are written to ignored `test-results/`. A live conversation still requires your privately configured API key.

## How it works

React asks a narrow, isolated preload bridge for a session token. Electron main calls the loopback FastAPI endpoint. Python alone reads the key and exchanges it for a temporary token using `personaConfig.personaId`. The token returns to React, and the Anam SDK establishes the video/audio connection directly. Session tokens are held in memory only.

The endpoint rejects browser origins and unexpected hosts, requires an Electron-specific header, limits token attempts, and sanitizes upstream errors. The header is a cross-origin guard, not authentication against other local programs. Do not expose this local development backend to the network.

Electron's [window documentation](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles) says native resizing can break transparent windows. This app keeps native resizing off and changes the window bounds programmatically when expanding, collapsing or choosing an avatar size. The window background is transparent; the avatar video keeps whatever background Anam renders. Transparent margins do not provide click-through behavior.

## Troubleshooting

- **Cannot reach local backend:** launch Uvicorn using the first command above. `curl http://127.0.0.1:8765/health` checks availability without exposing credentials.
- **Missing key:** fill the blank `ANAM_API_KEY` value in `backend/.env`. Never add it to a root `.env` or a `VITE_` variable.
- **Rejected persona/key:** confirm the key and persona belong to the same Anam account and the key has access.
- **Microphone denied on macOS:** allow Electron (or the terminal host shown by macOS) in System Settings → Privacy & Security → Microphone, then relaunch. A future packaged app must include `NSMicrophoneUsageDescription` and appropriate signing entitlements.
- **Connection blocked:** allow Anam HTTPS/WSS endpoints and WebRTC/TURN traffic as described in the [network guide](https://anam.ai/docs/security/network).
- **Transparent window appears opaque while debugging:** Electron DevTools can disable transparency; close DevTools.

Live sources: [quickstart](https://anam.ai/docs/javascript-sdk/quickstart), [documentation index](https://anam.ai/docs/llms.txt), [server-side saved-persona flow](https://anam.ai/docs/javascript-sdk/production). The quickstart includes browser-side API-key code; this project follows the production guide and keeps the key only in Python.
