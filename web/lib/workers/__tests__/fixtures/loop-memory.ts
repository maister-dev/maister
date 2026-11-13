import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { runWorkerLoop } from "../../loop";

// Load the real Flight debug hooks in a separate process: installing them in
// Vitest would instrument the test runner itself for the rest of the suite.
const require = createRequire(import.meta.url);

require("next/dist/compiled/react-server-dom-turbopack/server.node");

const collectGarbage = globalThis.gc;

assert.ok(collectGarbage, "run the fixture with --expose-gc");

const controller = new AbortController();
const heapSamples: number[] = [];
let iterations = 0;

await runWorkerLoop(controller.signal, async () => {
  for (let operation = 0; operation < 50; operation += 1)
    await Promise.resolve();
  iterations += 1;
  if (iterations % 1_000 === 0) {
    await yieldToEventLoop();
    collectGarbage();
    heapSamples.push(process.memoryUsage().heapUsed);
  }
  if (iterations === 5_000) controller.abort();
});

assert.equal(iterations, 5_000);
const growthBytes = heapSamples[heapSamples.length - 1] - heapSamples[0];

// An endless async/await loop retains ~60 MiB across these samples with the
// installed Flight hooks. Independent iterations stay flat after warm-up.
assert.ok(growthBytes < 16 * 1_024 * 1_024, JSON.stringify({ heapSamples }));

const aborted = new AbortController();

aborted.abort();
await runWorkerLoop(aborted.signal, async () => {
  assert.fail("an aborted worker must not start work");
});

const draining = new AbortController();
let finished = false;

await runWorkerLoop(draining.signal, async () => {
  assert.equal(finished, false, "iterations must not overlap");
  draining.abort();
  await yieldToEventLoop();
  finished = true;
});
assert.equal(finished, true, "abort must join in-flight work");

const failure = new Error("worker failure");

await assert.rejects(
  runWorkerLoop(new AbortController().signal, async () => {
    throw failure;
  }),
  (error: unknown) => error === failure,
);
