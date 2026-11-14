import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// @pointy/shared is TypeScript source in the workspace, so it must be bundled, not externalized.
const bundleWorkspace = { exclude: ["@pointy/shared"] };

export default defineConfig({
  main: {
    build: {
      externalizeDeps: bundleWorkspace,
      rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } },
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
        },
      },
    },
  },
});
