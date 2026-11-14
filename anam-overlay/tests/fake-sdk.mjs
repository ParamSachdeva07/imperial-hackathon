// Used only by the test Vite server. Production imports the real published SDK.
export { AnamEvent } from '../node_modules/@anam-ai/js-sdk/dist/module/types/events/public/AnamEvent.js';
export { ConnectionClosedCode } from '../node_modules/@anam-ai/js-sdk/dist/module/types/events/public/ConnectionClosedCodes.js';
import { AnamEvent } from '../node_modules/@anam-ai/js-sdk/dist/module/types/events/public/AnamEvent.js';
import { ConnectionClosedCode } from '../node_modules/@anam-ai/js-sdk/dist/module/types/events/public/ConnectionClosedCodes.js';

window.__anamFixture = { clients: [], delay: 30, fail: false, trackStops: 0 };
export function createClient(token, options) {
  const fixture = window.__anamFixture;
  const listeners = new Map();
  const client = {
    token, options, stopCount: 0, muted: false,
    addListener(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
    },
    removeListener(event, callback) { listeners.get(event)?.delete(callback); },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
    emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args); },
    async streamToVideoElement(id) {
      if (!document.getElementById(id)) throw new Error('Video element missing');
      await new Promise((resolve) => setTimeout(resolve, fixture.delay));
      if (fixture.fail) throw new Error('secret-upstream-debug-details');
      if (!options.disableInputAudio) client.emit(AnamEvent.INPUT_AUDIO_STREAM_STARTED, {
        getTracks: () => [{ stop() { fixture.trackStops++; } }],
      });
      client.emit(AnamEvent.VIDEO_PLAY_STARTED);
    },
    async stopStreaming() { client.stopCount++; client.emit(AnamEvent.CONNECTION_CLOSED, ConnectionClosedCode.NORMAL); },
    muteInputAudio() { client.muted = true; return { isMuted: true }; },
    unmuteInputAudio() { client.muted = false; return { isMuted: false }; },
    sendUserMessage(content) {
      client.sent = content;
      client.emit(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, { id: 'reply', role: 'persona', content: 'Hello, ' });
      client.emit(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, { id: 'reply', role: 'persona', content: 'I’m here.' });
    },
    disconnect() { client.emit(AnamEvent.CONNECTION_CLOSED, ConnectionClosedCode.WEBRTC_FAILURE); },
  };
  fixture.clients.push(client);
  return client;
}
