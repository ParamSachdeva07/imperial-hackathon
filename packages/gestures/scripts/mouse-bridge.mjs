// Local bridge that lets the playground move the REAL system mouse.
// Browsers can't move the OS cursor, so the page sends normalized positions
// over a localhost WebSocket and this process moves the mouse with nut-js.
//
//   npm run mouse-bridge      (in a second terminal, next to `npm run dev`)
//
// In the Electron app this script is not needed: the main process does the
// same thing directly (nut-js or agent-desktop) when it receives a "mouse" event.
import { WebSocketServer } from "ws";

const PORT = 8765;
// Only our own dev page may drive the mouse (any website could otherwise connect to localhost).
const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

let nut;
try {
  nut = await import("@nut-tree-fork/nut-js");
} catch (err) {
  console.error("Could not load @nut-tree-fork/nut-js. Run `npm install` again and check for errors.");
  console.error(String(err));
  process.exit(1);
}
const { mouse, screen, Point } = nut;
mouse.config.autoDelayMs = 0;
mouse.config.mouseSpeed = 100000;

const width = await screen.width();
const height = await screen.height();

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("connection", (socket, req) => {
  const origin = req.headers.origin ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    console.warn(`Rejected connection from origin "${origin}"`);
    socket.close(1008, "origin not allowed");
    return;
  }
  console.log("Playground connected — one finger moves your mouse, holding still clicks.");

  let busy = false;
  let pending = null; // latest move only (older moves are useless)
  const clicks = []; // clicks are never dropped

  const toPoint = ({ u, v }) =>
    new Point(
      Math.round(Math.min(1, Math.max(0, u)) * (width - 1)),
      Math.round(Math.min(1, Math.max(0, v)) * (height - 1)),
    );

  const flush = async () => {
    if (busy) return;
    busy = true;
    try {
      while (clicks.length || pending) {
        if (clicks.length) {
          const c = clicks.shift();
          await mouse.setPosition(toPoint(c));
          await mouse.leftClick();
          console.log("click");
        } else {
          const p = pending;
          pending = null;
          await mouse.setPosition(toPoint(p));
        }
      }
    } catch (err) {
      console.error("mouse action failed:", String(err));
    } finally {
      busy = false;
    }
  };

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof msg?.u !== "number" || typeof msg?.v !== "number") return;
    if (msg.type === "click") clicks.push({ u: msg.u, v: msg.v });
    else pending = { u: msg.u, v: msg.v }; // keep only the latest position
    flush();
  });

  socket.on("close", () => console.log("Playground disconnected."));
});

console.log(`Mouse bridge listening on ws://127.0.0.1:${PORT} (screen ${width}×${height}). Ctrl+C to stop.`);
