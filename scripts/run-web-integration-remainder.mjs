import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runStageAbLane, webRemainderFiles } from "./run-stage-ab-tests.mjs";

if (process.argv.length !== 2) {
  throw new Error(
    "The integration remainder accepts no arguments; use vitest --project integration <file> for a focused check.",
  );
}

const root = fileURLToPath(new URL("../web/", import.meta.url));
const inventory = globSync(
  "{lib,app,scripts,test-support,e2e}/**/*.integration.test.ts",
  { cwd: root },
);
const files = webRemainderFiles(inventory);

if (files.length === 0)
  throw new Error("The web integration remainder is empty");

await runStageAbLane({ slice: "web", files });
