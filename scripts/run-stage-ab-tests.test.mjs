import assert from "node:assert/strict";
import { test } from "node:test";

import { laneConcurrency, lanePackages, laneSuites, vitestArgs } from "./run-stage-ab-tests.mjs";

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
    "--reporter=json", "--outputFile=/tmp/r.json", "--maxWorkers=3", "--minWorkers=1",
  ]);
});

test("every lane still declares its owning suites and package", () => {
  assert.ok(laneSuites.web.length > 0 && laneSuites.supervisor.length > 0 && laneSuites.isolation.length > 0);
  for (const [slice, files] of Object.entries(laneSuites)) {
    assert.ok(Object.hasOwn(lanePackages, slice), `${slice} names its package`);
    for (const file of files) assert.match(file, /\.integration\.test\.ts$/u);
  }
});

// The isolation suite builds the production web and owns two process trees,
// so it never shares the host with a sibling worker.
test("the isolation slice runs serially on any host", () => {
  for (const parallelism of [1, 4, 16, 64]) assert.equal(laneConcurrency(parallelism, "isolation"), 1);
  assert.equal(laneConcurrency(16, "web"), 4);
});
