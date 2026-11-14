import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// Standalone launcher for the gesture service (electron/dev). Output goes to out/ (ignored by ESLint/git).
// CommonJS output: this package is "type": "module", but Electron's sandboxed preloads need CJS.
const cjs = { format: "cjs" as const, entryFileNames: "[name].cjs" };

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      // nut-js ships a native addon: load it from node_modules at runtime, never bundle it.
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/dev/main.ts") },
        external: [/^@nut-tree-fork\//],
        output: cjs,
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      // Sandboxed preloads cannot require() packages or shared chunks: bundle each entry fully.
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: {
        input: {
          gestures: resolve(__dirname, "src/electron/preload.ts"),
          feedback: resolve(__dirname, "src/electron/feedbackPreload.ts"),
        },
        output: cjs,
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "electron/dev"),
    publicDir: resolve(__dirname, ".cache/public"),
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: {
          vision: resolve(__dirname, "electron/dev/vision.html"),
          feedback: resolve(__dirname, "electron/dev/feedback.html"),
        },
      },
    },
  },
});
