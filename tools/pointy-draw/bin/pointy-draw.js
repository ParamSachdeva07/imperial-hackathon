#!/usr/bin/env node
// Thin launcher: run the TypeScript CLI through tsx.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
