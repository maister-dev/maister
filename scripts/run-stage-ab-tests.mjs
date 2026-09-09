import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSupportedNode } from "../runtime/node-version.ts";

// Explicit owning seams make a renamed or undiscovered suite fail the lane.
export const laneSuites = {
  supervisor: [
    "host-identity", "runtime-event-outbox", "runtime-event-ack",
    "runtime-storage", "runtime-file-budget", "runtime-event-pressure",
    "runtime-objects", "command-receipts", "lifecycle", "output-memory",
  ].map((name) => `src/__tests__/${name}.integration.test.ts`),
  web: [
    "lib/__tests__/supervisor-client-binary.integration.test.ts",
    "lib/agents/__tests__/prompt-owners.integration.test.ts",
    "lib/agents/__tests__/finalization-transaction.integration.test.ts",
    "lib/agents/__tests__/turn-admission.integration.test.ts",
    "lib/flows/graph/__tests__/prompt-owners.integration.test.ts",
    "lib/flows/graph/__tests__/consensus-prompt-owners.integration.test.ts",
    "lib/flows/graph/__tests__/permission-resume.integration.test.ts",
    "lib/flows/graph/__tests__/gate-permission-resume.integration.test.ts",
    "lib/flows/graph/__tests__/gate-permission-result.integration.test.ts",
    "lib/flows/graph/__tests__/permission-result-failure.integration.test.ts",
    "lib/flows/graph/__tests__/driver-claim.integration.test.ts",
    "lib/scratch-runs/__tests__/prompt-owners.integration.test.ts",
    "lib/scratch-runs/__tests__/local-package-assistant.integration.test.ts",
    "lib/services/__tests__/gate-chat.integration.test.ts",
    "lib/runs/__tests__/sync-resolver.integration.test.ts",
    "lib/runs/__tests__/sync-recovery.integration.test.ts",
    "lib/runs/__tests__/resume-recovery.integration.test.ts",
    ...["commands", "immutable-commands", "command-recovery", "deliverer", "lifecycle-regression", "bounded-output", "runtime-object-retention", "runtime-object-lifecycle", "runtime-object-declarations-migration", "command-retirement", "prompt-owner-activation"]
      .map((name) => `lib/execution-host/__tests__/${name}.integration.test.ts`),
    ...["ingest", "event-claim-lock", "projection-worker"]
      .map((name) => `lib/execution-host/events/__tests__/${name}.integration.test.ts`),
  ],
  // AT-16: one real production web (fresh `next build`, `server.ts`) under a
  // kernel isolation driver against a real supervisor — runs alone because
  // the build and both process trees own the host.
  isolation: ["test-support/__tests__/execution-ab-isolation.integration.test.ts"],
};
// The package directory each slice runs in.
export const lanePackages = { supervisor: "supervisor", web: "web", isolation: "web" };
// Slices whose suites own the whole host run one at a time regardless of parallelism.
const SERIAL_SLICES = new Set(["isolation"]);

// A lane suite owns a stack of host processes — its vitest worker, a PostgreSQL
// container, a real supervisor and at least one forked driver child — so the
// pool is sized from that budget. Vitest's default worker count admits one
// stack per core, and the resulting contention expires bounded waits inside
// healthy suites, which makes a zero-failure gate run unreproducible.
const SUITE_HOST_PROCESSES = 4;
const LANE_MAX_CONCURRENCY = 4;

export function laneConcurrency(parallelism, slice = "web") {
  if (SERIAL_SLICES.has(slice) || !(parallelism > 0)) return 1;

  return Math.max(1, Math.min(LANE_MAX_CONCURRENCY, Math.floor(parallelism / SUITE_HOST_PROCESSES)));
}

export function vitestArgs({ files, reportPath, concurrency }) {
  return [
    "node_modules/vitest/vitest.mjs", "run", ...files, "--project=integration",
    "--reporter=json", `--outputFile=${reportPath}`,
    `--maxWorkers=${concurrency}`, "--minWorkers=1",
  ];
}

async function main() {
  assertSupportedNode(process.versions.node);
  const slice = process.argv[2];

  assert(Object.hasOwn(laneSuites, slice ?? ""), "usage: run-stage-ab-tests.mjs web|supervisor|isolation");
  const files = laneSuites[slice];
  const cwd = fileURLToPath(new URL(`../${lanePackages[slice]}/`, import.meta.url));

  await Promise.all(files.map((file) => access(join(cwd, file))));
  const directory = await mkdtemp(join(tmpdir(), `maister-ab-${slice}-`));
  const reportPath = join(directory, "vitest.json");
  const concurrency = laneConcurrency(availableParallelism(), slice);
  const child = spawn(process.execPath, vitestArgs({ files, reportPath, concurrency }), { cwd, stdio: "inherit" });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  console.log(JSON.stringify({ slice, node: process.versions.node, bundledUndici: process.versions.undici, concurrency, reportPath, ...status }));
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
  console.log(JSON.stringify({ slice, passed: report.numPassedTests, suites: files.length, concurrency, reportPath }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
