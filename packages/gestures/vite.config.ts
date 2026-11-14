import { defineConfig } from "vite";

export default defineConfig({
  root: "playground",
  // Generated assets live in .cache/ and dist/, which the repo's ESLint config ignores.
  publicDir: "../.cache/public",
  build: { outDir: "../dist", emptyOutDir: true },
});
