import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { runStageAbLane } from "./run-stage-ab-tests.mjs";

/**
 * Collect the complete source inventory without following directory symlinks.
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function integrationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filename = join(directory, entry.name);

      if (entry.isDirectory()) return integrationFiles(filename);

      return entry.isFile() && entry.name.endsWith(".integration.test.ts")
        ? [filename]
        : [];
    }),
  );

  return nested.flat();
}

if (process.argv.length !== 2) {
  throw new Error(
    "Full Supervisor integration accepts no arguments. Use pnpm --filter @maister/supervisor exec vitest run --project integration <file> for focused checks; focused checks do not qualify the full suite.",
  );
}

const supervisorRoot = fileURLToPath(
  new URL("../supervisor/", import.meta.url),
);
const files = (await integrationFiles(join(supervisorRoot, "src")))
  .map((filename) => relative(supervisorRoot, filename).split(sep).join("/"))
  .sort();

if (files.length === 0)
  throw new Error("The full Supervisor integration inventory is empty");

await runStageAbLane({ slice: "supervisor", files });
