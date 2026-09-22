import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, it } from "vitest";

import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import {
  probeFilesystemAccess,
  resolveIsolationDriver,
} from "@/test-support/process-isolation";
import { mkdtempReal } from "@/test-support/worktree-test-root";

it("I-CI: the real driver denies the host root and the real PostgreSQL container is reachable", async () => {
  const startedAt = Date.now();
  const driver = resolveIsolationDriver();
  const root = await mkdtempReal("s52-driver-preflight-");
  const hostRoot = path.join(root, "host");
  const hostFile = path.join(hostRoot, "private.txt");
  const webFile = path.join(root, "web.txt");

  await mkdir(hostRoot);
  await writeFile(hostFile, "host-private");
  await writeFile(webFile, "web-public");
  expect(await probeFilesystemAccess(driver, [hostRoot], hostFile)).toEqual({
    outcome: "denied",
    code: driver.deniedCode,
  });
  expect(await probeFilesystemAccess(driver, [hostRoot], webFile)).toEqual({
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
        deniedCode: driver.deniedCode,
        durationMs: Date.now() - startedAt,
        outcome: "passed",
      }),
    );
  } finally {
    await database.stop();
  }
}, 180_000);
