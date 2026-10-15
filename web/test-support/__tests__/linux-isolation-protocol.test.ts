import type { LinuxIsolationPolicy } from "../linux-isolation";

import { expect, it } from "vitest";

import {
  decodeLinuxIsolationPolicy,
  serializeLinuxIsolationPolicy,
} from "../linux-isolation-protocol";

const root =
  "/home/maister/.maister/worktrees/maister/codex-s53a-linux-isolation";
const policy: LinuxIsolationPolicy = {
  version: 1,
  invocation: { id: "policy-roundtrip", directory: "/tmp/policy-evidence" },
  cwd: `${root}/web`,
  mounts: Array.from({ length: 450 }, (_, index) => {
    const source = `${root}/node_modules/.pnpm/package-${index}/node_modules`;

    return {
      source,
      destination: index === 0 ? `${root}/web/dependency-alias` : source,
      device: 1,
      inode: index + 1,
      access: "read-only",
      directory: true,
    };
  }),
  deniedRoots: ["/tmp/private"],
  protectedFiles: [],
  writableOwners: [],
  symlinks: [],
  environmentKeys: [],
};

it("round-trips a long-worktree policy within the unchanged argument bound", () => {
  const original = JSON.stringify(policy);

  expect(Buffer.byteLength(original)).toBeGreaterThan(112 * 1024);
  const encoded = serializeLinuxIsolationPolicy(policy);

  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(112 * 1024);
  expect(decodeLinuxIsolationPolicy(encoded)).toEqual(policy);
  expect(JSON.stringify(policy)).toBe(original);
  expect(Object.isFrozen(decodeLinuxIsolationPolicy(encoded).mounts[0])).toBe(
    true,
  );
});

it("refuses a missing destination instead of treating it as the compact marker", () => {
  const { destination: _destination, ...mount } = policy.mounts[0];

  expect(() =>
    decodeLinuxIsolationPolicy(JSON.stringify({ ...policy, mounts: [mount] })),
  ).toThrow("invalid isolation mount record");
});

it("retains both encode and decode bounds after compacting identical paths", () => {
  const oversized = { ...policy, cwd: `/${"x".repeat(112 * 1024)}` };

  expect(() => serializeLinuxIsolationPolicy(oversized)).toThrow(
    "isolation launch policy exceeded its 112KiB bound",
  );
  expect(() => decodeLinuxIsolationPolicy(JSON.stringify(oversized))).toThrow(
    "isolation launch policy exceeded its 112KiB bound",
  );
});
