import assert from "node:assert/strict";
import { test } from "node:test";

import { laneConcurrency, lanePackages, laneSuites, vitestArgs, validateLaneReport, requiredIsolationCases } from "./run-stage-ab-tests.mjs";

// Each lane suite owns a stack of host processes (vitest worker, PostgreSQL
// container, real supervisor, one forked driver child), so the pool is derived
// from that budget rather than from vitest's default worker count.
test("lane concurrency is a bounded pool derived from host parallelism", () => {
  assert.equal(laneConcurrency(16), 4);
  assert.equal(laneConcurrency(12), 3);
  assert.equal(laneConcurrency(8), 2);
  assert.equal(laneConcurrency(4), 1);
  assert.equal(laneConcurrency(1), 1);
});

test("lane concurrency never degenerates below one worker", () => {
  for (const parallelism of [0, -3, Number.NaN, undefined]) assert.equal(laneConcurrency(parallelism), 1);
});

test("lane concurrency is capped so a large host cannot restore saturation", () => {
  for (const parallelism of [32, 64, 256, Number.POSITIVE_INFINITY]) assert.equal(laneConcurrency(parallelism), 4);
});

test("the runner passes the pool bound to vitest with the existing lane flags", () => {
  const args = vitestArgs({ files: ["a.integration.test.ts"], reportPath: "/tmp/r.json", concurrency: 3 });

  assert.deepEqual(args, [
    "node_modules/vitest/vitest.mjs", "run", "a.integration.test.ts", "--project=integration",
    "--reporter=json", "--outputFile=/tmp/r.json", "--reporter=default", "--maxWorkers=3", "--minWorkers=1",
  ]);
});

test("every lane still declares its owning suites and package", () => {
  assert.ok(laneSuites.web.length > 0 && laneSuites.supervisor.length > 0 && laneSuites.isolation.length > 0);
  for (const [slice, files] of Object.entries(laneSuites)) {
    assert.ok(Object.hasOwn(lanePackages, slice), `${slice} names its package`);
    for (const file of files) assert.match(file, /\.integration\.test\.ts$/u);
  }
});

test("the web lane runs the batched-ingest controls and never the opt-in load harness", () => {
  for (const name of ["ingest-batch", "ingest-batch-walk", "ingest-batch-locks", "consumer-batching"])
    assert.ok(laneSuites.web.includes(`lib/execution-host/events/__tests__/${name}.integration.test.ts`), name);
  for (const files of Object.values(laneSuites))
    assert.ok(!files.some((file) => file.includes("event-plane-load")), "the R20 harness is opt-in");
});

// The isolation suite builds the production web and owns two process trees,
// so it never shares the host with a sibling worker.
test("the isolation slice runs serially on any host", () => {
  for (const parallelism of [1, 4, 16, 64]) assert.equal(laneConcurrency(parallelism, "isolation"), 1);
  assert.equal(laneConcurrency(16, "web"), 4);
});

// A surviving test in a suite is not evidence that all required fault windows ran.
test("the isolation report refuses a missing required case in a nonempty passing suite", () => {
  const file = "test-support/__tests__/execution-ab-isolation.integration.test.ts";
  const report = {
    testResults: [{ name: `/repo/web/${file}`, assertionResults: [
      { title: "I1: the web identity is denied the host's private root while the harness and the host keep it", status: "passed" },
    ] }],
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    numRuntimeErrorTestSuites: 0, success: true,
  };

  assert.throws(() => validateLaneReport(report, [file]), /required case/);
});

test("the complete isolation manifest passes and rejects duplicate or skipped required cases", () => {
  const files = Object.keys(requiredIsolationCases);
  const report = {
    testResults: files.map((file) => ({ name: `/repo/web/${file}`, assertionResults:
      requiredIsolationCases[file].map((title) => ({ title, status: "passed" })) })),
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    numRuntimeErrorTestSuites: 0, success: true,
  };

  validateLaneReport(report, files);
  const duplicated = structuredClone(report);
  duplicated.testResults[0].assertionResults.push(duplicated.testResults[0].assertionResults[0]);
  assert.throws(() => validateLaneReport(duplicated, files), /required case/);
  const skipped = structuredClone(report);
  skipped.testResults[0].assertionResults[0].status = "pending";
  assert.throws(() => validateLaneReport(skipped, files), /case failed or was skipped/);
});
