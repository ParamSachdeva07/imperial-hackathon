import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "./packages/shared",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "desktop-main",
          root: "./apps/desktop",
          include: ["src/main/**/*.test.ts", "src/dev/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "desktop-renderer",
          root: "./apps/desktop",
          include: ["src/renderer/**/*.test.{ts,tsx}"],
          environment: "jsdom",
        },
      },
      {
        test: {
          name: "broker",
          root: "./backend/explainer-broker",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "cli",
          root: "./tools/pointy-draw",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "scripts",
          root: "./scripts",
          include: ["**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
