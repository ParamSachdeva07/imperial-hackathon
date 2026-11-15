/**
 * Writes the model-facing function-tool definitions to packages/shared/generated/overlay-tools.json
 * (MVP) and overlay-tools.stretch.json (MVP + stretch), for the voice/agent teammate.
 *   npm run gen:tools
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportToolDefinitions } from "../src/overlay/tools";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "generated");
mkdirSync(outDir, { recursive: true });
const write = (file: string, data: unknown) => {
  writeFileSync(join(outDir, file), JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote ${join("packages/shared/generated", file)}`);
};
write("overlay-tools.json", exportToolDefinitions());
write("overlay-tools.stretch.json", exportToolDefinitions({ includeStretch: true }));
