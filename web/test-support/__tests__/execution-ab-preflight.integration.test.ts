import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, it } from "vitest";

import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import {
  probeFilesystemAccess,
  resolveIsolationDriver,
} from "@/test-support/process-isolation";
import {
  linuxRuntimePaths,
  prepareLinuxIsolationPolicy,
} from "@/test-support/linux-isolation";
import { invocationFromEnvironment } from "@/test-support/process-invocation";
import { assertNoLinuxDockerTcpAuthority } from "@/test-support/linux-network-authority";
import { mkdtempReal } from "@/test-support/worktree-test-root";

it("I-CI: the real driver denies the host root and the real PostgreSQL container is reachable", async () => {
  const startedAt = Date.now();
  const driver = resolveIsolationDriver();

  if (driver.name === "bubblewrap") await assertNoLinuxDockerTcpAuthority();

  const root = await mkdtempReal("s52-driver-preflight-");
  const hostRoot = path.join(root, "host");
  const hostFile = path.join(hostRoot, "private.txt");
  const webFile = path.join(root, "web.txt");

  await mkdir(hostRoot);
  await writeFile(hostFile, "host-private");
  await writeFile(webFile, "web-public");
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new Error("preflight requires its own test invocation");
  const policy =
    driver.name === "bubblewrap"
      ? await prepareLinuxIsolationPolicy({
          invocation,
          cwd: root,
          readOnlyPaths: [webFile, ...linuxRuntimePaths([process.execPath])],
          writableRoots: [],
          deniedRoots: [hostRoot],
          protectedFiles: [{ path: hostFile }],
        })
      : undefined;

  expect(
    await probeFilesystemAccess(driver, [hostRoot], hostFile, policy),
  ).toEqual({
    outcome: "denied",
    code: driver.deniedCode,
  });
  expect(
    await probeFilesystemAccess(driver, [hostRoot], webFile, policy),
  ).toEqual({
    outcome: "readable",
    bytes: 10,
  });
  expect(await readFile(hostFile, "utf8")).toBe("host-private");
  const database = await startMainAndBrainPostgresTestDb({
    databaseName: "s52_driver_preflight",
  });

  try {
    const result = await database.pool.query<{ value: number }>(
      "SELECT 52::integer AS value",
    );

    expect(result.rows).toEqual([{ value: 52 }]);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        caseName: "I-CI",
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        driver: driver.name,
        phase: "migrated-postgres-query",
        deniedCode: driver.deniedCode,
        durationMs: Date.now() - startedAt,
        outcome: "passed",
      }),
    );
  } finally {
    await database.stop();
  }
}, 360_000);
