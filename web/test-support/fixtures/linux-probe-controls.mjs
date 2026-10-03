import assert from "node:assert/strict";

import { decodeLinuxIsolationPolicy } from "../linux-isolation-protocol.ts";
import {
  invocationRecords,
  readProcessSnapshot,
} from "../process-invocation.ts";
import {
  probeFilesystemAccess,
  resolveIsolationDriver,
} from "../process-isolation.ts";

const policy = decodeLinuxIsolationPolicy(process.argv[2] ?? "");
const target = process.argv[3];
const driver = resolveIsolationDriver();
const invocation = policy.invocation;
const before = await invocationRecords(invocation);

/** @param {string} program @returns {import('../process-isolation.ts').IsolationDriver} */
function probeProgram(program) {
  return {
    ...driver,
    wrap(command, deniedRoots, immutablePolicy) {
      return driver.wrap(
        [command[0], "-e", program],
        deniedRoots,
        immutablePolicy,
      );
    },
  };
}

const controls = [
  {
    driver: probeProgram("process.stdout.write('{malformed')"),
    expected: /exactly one JSON result/,
  },
  {
    driver: probeProgram("process.stdout.write('x'.repeat(17000))"),
    expected: /output exceeded its bound/,
  },
  {
    driver: probeProgram("process.kill(process.pid, 'SIGTERM')"),
    expected: /access probe application failed/,
  },
  {
    driver: probeProgram("setInterval(() => {}, 1000)"),
    expected: /20000ms deadline/,
  },
];

for (const control of controls)
  await assert.rejects(
    probeFilesystemAccess(control.driver, policy.deniedRoots, target, policy),
    control.expected,
  );

/** @type {import('../process-isolation.ts').IsolationDriver} */
const unavailableExecutable = {
  ...driver,
  wrap() {
    return {
      file: "/maister-deliberately-unavailable-probe-executable",
      args: [],
    };
  },
};

await assert.rejects(
  probeFilesystemAccess(
    unavailableExecutable,
    policy.deniedRoots,
    target,
    policy,
  ),
  /spawn|identity|captured|ENOENT/,
);
const after = await invocationRecords(invocation);
const registeredBefore = before.filter(
  (record) =>
    record.kind === "process" && record.rootRole === "isolation-probe",
).length;
const registeredAfter = after.filter(
  (record) =>
    record.kind === "process" && record.rootRole === "isolation-probe",
).length;

assert.equal(
  registeredAfter - registeredBefore,
  4,
  "every actual probe must register its captured direct child",
);
const live = (await readProcessSnapshot(invocation)).filter(
  (identity) =>
    identity.owned && !identity.zombie && identity.pid !== process.pid,
);

assert.deepEqual(
  live,
  [],
  "probe failure left an owned namespace or descendant alive",
);
process.stdout.write(
  JSON.stringify({
    event: "linux-probe-failure-controls",
    passed: 5,
    registered: 4,
    live: live.length,
    node: process.versions.node,
  }) + "\n",
);
