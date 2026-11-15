import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// @pointy/shared is TypeScript source in the workspace, so it must be bundled, not externalized.
// @pointy/gestures is TS source too (its nut-js mouse addon stays external, see main.rollupOptions).
const bundleWorkspace = { exclude: ["@pointy/shared", "@pointy/gestures"] };

export default defineConfig({
  main: {
    build: {
      externalizeDeps: bundleWorkspace,
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        external: [/^@nut-tree-fork\//], // native addon: loaded lazily at runtime, never bundled
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads cannot require() packages: bundle everything.
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, "src/preload/overlay.ts"),
          fixture: resolve(__dirname, "src/preload/fixture.ts"),
          voice: resolve(__dirname, "src/preload/voice.ts"),
          gestures: resolve(__dirname, "src/preload/gestures.ts"),
          gestureFeedback: resolve(__dirname, "src/preload/gestureFeedback.ts"),
          assistant: resolve(__dirname, "src/preload/assistant.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    // anam-overlay owns 5173 (strictPort); keep the Pointy renderer off it.
    server: { port: 5180 },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, "src/renderer/overlay/index.html"),
          fixture: resolve(__dirname, "src/renderer/fixture/index.html"),
          gallery: resolve(__dirname, "src/renderer/gallery/index.html"),
          voice: resolve(__dirname, "src/renderer/voice/index.html"),
          gestures: resolve(__dirname, "src/renderer/gestures/index.html"),
          gestureFeedback: resolve(__dirname, "src/renderer/gestureFeedback/index.html"),
          assistant: resolve(__dirname, "src/renderer/assistant/index.html"),
        },
      },
    },
  },
});
