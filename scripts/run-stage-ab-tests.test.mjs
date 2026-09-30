import assert from "node:assert/strict";
import { test } from "node:test";

import { laneConcurrency, lanePackages, laneSuites, vitestArgs, validateLaneReport, requiredIsolationCases, webShardFiles, parseLaneInvocation } from "./run-stage-ab-tests.mjs";

test("web shards are deterministic, disjoint, complete and retain manifest order", () => {
  const first = webShardFiles(laneSuites.web, 1, 2);
  const second = webShardFiles(laneSuites.web, 2, 2);

  assert.deepEqual(first, laneSuites.web.filter((_, index) => index % 2 === 0));
  assert.deepEqual(second, laneSuites.web.filter((_, index) => index % 2 === 1));
  assert.deepEqual([...first, ...second].sort(), [...laneSuites.web].sort());
});

test("CLI accepts only valid web shards and preserves unsharded slices", () => {
  assert.deepEqual(parseLaneInvocation(["web", "--shard", "2/2"]),
    { slice: "web", files: webShardFiles(laneSuites.web, 2, 2) });
  assert.deepEqual(parseLaneInvocation(["supervisor"]), { slice: "supervisor", files: laneSuites.supervisor });
  for (const args of [[], ["web", "--shard"], ["web", "--shard", "0/2"],
    ["web", "--shard", "3/2"], ["web", "--shard", "1/0"],
    ["web", "--shard", `1/${laneSuites.web.length + 1}`], ["web", "--shard", "1/2", "--shard", "2/2"],
    ["web", "--unknown"], ["isolation", "--shard", "1/2"],
    ["supervisor", "--shard", "1/2"]]) {
    assert.throws(() => parseLaneInvocation(args), /usage|shard/u, args.join(" "));
  }
});

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
  for (const file of [
    "lib/__tests__/permission-crash-boundary.integration.test.ts",
    "lib/__tests__/reconcile-sweep.integration.test.ts",
    "lib/db/__tests__/migration-0192-scratch-prompt-intent.integration.test.ts",
    "lib/flows/graph/__tests__/cli-driver-reconcile.integration.test.ts",
    "lib/scratch-runs/__tests__/incarnation-terminal.integration.test.ts",
    "lib/scratch-runs/__tests__/permission-terminal.integration.test.ts",
    "lib/scheduler/__tests__/system-sweep-admission.integration.test.ts",
  ]) assert.ok(laneSuites.web.includes(file), `R9 owning suite is mandatory: ${file}`);
  const restartControl = "lib/scratch-runs/__tests__/dispatch-window.integration.test.ts";
  assert.ok(laneSuites.isolation.includes(restartControl));
  assert.ok(!laneSuites.web.includes(restartControl), "production restarts own the serial host");
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

test("the report rejects a duplicated selection and a name that only shares a suffix", () => {
  const file = laneSuites.web[0];
  const result = (name) => ({ name, assertionResults: [{ title: "control", status: "passed" }] });
  const report = { testResults: [result(`/repo/web/${file}`), result(`/repo/web/${file}`)], numFailedTests: 0,
    numPendingTests: 0, numTodoTests: 0, numRuntimeErrorTestSuites: 0, success: true };

  assert.throws(() => validateLaneReport(report, [file, file]), /duplicate/u);
  assert.throws(() => validateLaneReport({ ...report, testResults: [] }, [file]), /suite count/u);
  assert.throws(() => validateLaneReport(report, [file, laneSuites.web[1]]), /missing or duplicated/u);
  report.testResults = [result(`/repo/web/prefix${file}`)];
  assert.throws(() => validateLaneReport(report, [file]), /A\/B unexpected or ambiguous owning suite/u);
});
