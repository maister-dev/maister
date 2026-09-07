import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSupportedNode } from "../runtime/node-version.ts";

// Explicit owning seams make a renamed or undiscovered suite fail the lane.
const suites = {
  supervisor: [
    "host-identity", "runtime-event-outbox", "runtime-event-ack",
    "runtime-storage", "runtime-file-budget", "runtime-event-pressure",
    "runtime-objects", "command-receipts", "lifecycle", "output-memory",
  ].map((name) => `src/__tests__/${name}.integration.test.ts`),
  web: [
    "lib/__tests__/supervisor-client-binary.integration.test.ts",
    "lib/agents/__tests__/prompt-owners.integration.test.ts",
    "lib/agents/__tests__/finalization-transaction.integration.test.ts",
    "lib/flows/graph/__tests__/prompt-owners.integration.test.ts",
    "lib/flows/graph/__tests__/permission-resume.integration.test.ts",
    "lib/flows/graph/__tests__/gate-permission-resume.integration.test.ts",
    "lib/flows/graph/__tests__/gate-permission-result.integration.test.ts",
    "lib/flows/graph/__tests__/permission-result-failure.integration.test.ts",
    "lib/flows/graph/__tests__/driver-claim.integration.test.ts",
    ...["commands", "immutable-commands", "command-recovery", "deliverer", "lifecycle-regression", "bounded-output", "runtime-object-retention"]
      .map((name) => `lib/execution-host/__tests__/${name}.integration.test.ts`),
    ...["ingest", "event-claim-lock", "projection-worker"]
      .map((name) => `lib/execution-host/events/__tests__/${name}.integration.test.ts`),
  ],
};

assertSupportedNode(process.versions.node);
const slice = process.argv[2];
assert(Object.hasOwn(suites, slice ?? ""), "usage: run-stage-ab-tests.mjs web|supervisor");
const files = suites[slice];
const cwd = fileURLToPath(new URL(`../${slice}/`, import.meta.url));
await Promise.all(files.map((file) => access(join(cwd, file))));
const directory = await mkdtemp(join(tmpdir(), `maister-ab-${slice}-`));
const reportPath = join(directory, "vitest.json");
const child = spawn(process.execPath, [
  "node_modules/vitest/vitest.mjs", "run", ...files, "--project=integration",
  "--reporter=json", `--outputFile=${reportPath}`,
], { cwd, stdio: "inherit" });
const status = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
console.log(JSON.stringify({ slice, node: process.versions.node, bundledUndici: process.versions.undici, reportPath, ...status }));
assert.equal(status.code, 0, "A/B integration runner failed");
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(report.testResults.length, files.length, "A/B discovery omitted an owning suite");
for (const file of files) {
  const result = report.testResults.find((item) => item.name.endsWith(file));

  assert(result?.assertionResults.length > 0, `A/B discovery is empty: ${file}`);
  assert(result.assertionResults.every((item) => item.status === "passed"), `A/B case failed or was skipped: ${file}`);
}
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests ?? 0, 0);
console.log(JSON.stringify({ slice, passed: report.numPassedTests, suites: files.length, reportPath }));
