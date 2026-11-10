import assert from "node:assert/strict";

import { acquireProductionBuildLock } from "../production-build-lock.ts";

const lockPath = process.argv[2];

assert(lockPath, "build-lock refusal control requires an owned lock path");
/** @type {unknown} */
let failure;

try {
  const release = await acquireProductionBuildLock(lockPath);

  await release();
} catch (error) {
  failure = error;
}

assert(failure instanceof Error, "missing lock identity did not refuse build");
assert.match(failure.message, /build lock owner identity is missing/u);
assert(
  failure.cause instanceof Error,
  "missing identity lost its filesystem cause",
);
assert.equal(Reflect.get(failure.cause, "code"), "ENOENT");
process.stdout.write(
  `${JSON.stringify({ event: "build-lock-missing-identity", outcome: "refused" })}\n`,
);
