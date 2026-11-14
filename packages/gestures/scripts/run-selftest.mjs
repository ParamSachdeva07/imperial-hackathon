// Runs the built launcher with synthetic hands (POINTY_GESTURES_SELFTEST=1); exit code = result.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron"); // path to the Electron binary
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = [root, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
const child = spawn(electron, args, { stdio: "inherit", env: { ...process.env, POINTY_GESTURES_SELFTEST: "1" } });
child.on("exit", (code) => process.exit(code ?? 1));
