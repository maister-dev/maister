import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Optional install scripts can otherwise hide a broken native build.
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
