import { defineConfig } from "vite";

export default defineConfig({
  root: "playground",
  publicDir: "../public",
  build: { outDir: "../dist-playground", emptyOutDir: true },
});
