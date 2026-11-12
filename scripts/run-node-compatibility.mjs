import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { runStageAbLane } from "./run-stage-ab-tests.mjs";

// Optional install scripts can otherwise hide a broken native build on a new Node major.
const sshRequire = [
  "testcontainers",
  "dockerode",
  "docker-modem",
  "ssh2",
].reduce(
  (require, name) => createRequire(require.resolve(name)),
  createRequire(new URL("../web/package.json", import.meta.url)),
);
const crypto = sshRequire("./protocol/crypto.js");

await crypto.init;
assert.equal(crypto.bindingAvailable, true, "ssh2 native crypto must load");
const cpu = sshRequire("cpu-features")();

assert.ok(
  cpu.arch.length > 0,
  "native CPU detection must return an architecture",
);
assert.equal(typeof cpu.flags, "object");

// Exercise native HTTP/streams, transaction ownership and a real production boot.
await runStageAbLane({
  slice: "web",
  files: [
    "lib/execution-host/__tests__/registrar.integration.test.ts",
    "lib/execution-host/events/__tests__/consumer-batching.integration.test.ts",
    "lib/scheduler/__tests__/clock-boot.integration.test.ts",
    "test-support/__tests__/real-supervisor.integration.test.ts",
  ],
});
