/** Node-only helpers shared by the app, the broker and the scripts. */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Load secrets (OPENAI_API_KEY, …) from the gitignored repo-root `.env`; a missing file is fine. */
export function loadRepoEnv(repoRoot: string): void {
  const file = join(repoRoot, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
