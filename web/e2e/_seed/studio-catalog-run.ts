import type { seedStudioCatalogProject } from "./studio-catalog-project";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, type APIRequestContext } from "@playwright/test";

import { singleValue, withE2EDb } from "./db";
import { waitForTaskLaunchRun } from "./task-launch";

export async function createFixture(
  testRoot: string,
  endpoint: string,
): Promise<Awaited<ReturnType<typeof seedStudioCatalogProject>>> {
  await mkdir(testRoot, { recursive: true });
  const fixtureHome = await mkdtemp(join(testRoot, "catalog-cache-"));
  const { stdout } = await withE2EDb(async (pool) => {
    const lock = await pool.connect();

    try {
      // Package installs refresh the global agent registry. Finish the fixture
      // refresh before another worker installs its own synthetic packages.
      await lock.query(
        "SELECT pg_advisory_lock(hashtextextended('e2e-studio-delivery-fixture', 0))",
      );

      return await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          "./scripts/_register-shim.mjs",
          "e2e/_seed/studio-catalog-project.ts",
          endpoint,
        ],
        {
          cwd: resolve("."),
          env: { ...process.env, HOME: fixtureHome, LOG_LEVEL: "error" },
          timeout: 90_000,
        },
      );
    } finally {
      lock.release(true);
    }
  });
  const line = stdout
    .split("\n")
    .find((value) => value.startsWith('{"project":'));

  if (!line) throw new Error("Catalog seed returned no project receipt");

  return JSON.parse(line) as Awaited<
    ReturnType<typeof seedStudioCatalogProject>
  >;
}

export async function launch(
  request: APIRequestContext,
  origin: string,
  selection: { taskId: string; flowId: string; runnerId: string },
): Promise<string> {
  const options = await request.get("/api/task-launch-intents/options", {
    params: selection,
  });

  expect(options.ok(), await options.text()).toBe(true);
  const { taskRevision, settingsToken } = await options.json();
  const accepted = await request.post("/api/task-launch-intents", {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: {
      ...selection,
      expectedTaskRevision: taskRevision,
      expectedSettingsToken: settingsToken,
      autoPromote: false,
    },
  });

  expect(accepted.status(), await accepted.text()).toBe(202);
  const receipt = await accepted.json();

  expect(receipt.taskId).toBe(selection.taskId);

  return waitForTaskLaunchRun(receipt);
}

export async function assertActive(runId: string): Promise<void> {
  const status = await singleValue<{
    run: string;
    attempt: string | null;
    decision: string | null;
  }>(
    "SELECT json_build_object('run',r.status,'attempt',n.status,'decision',n.decision) AS value FROM runs r LEFT JOIN node_attempts n ON n.run_id=r.id WHERE r.id=$1 ORDER BY n.attempt DESC LIMIT 1",
    [runId],
  );

  if (
    status &&
    (["Failed", "Crashed", "Cancelled", "Aborted", "Rejected"].includes(
      status.run,
    ) ||
      status.attempt === "Failed")
  ) {
    const promptError = await singleValue<string>(
      `SELECT last_error->>'message' AS value FROM execution_commands WHERE run_id=$1 AND kind='session.prompt'
       ORDER BY created_at DESC LIMIT 1`,
      [runId],
    );

    throw new Error(
      "Delivery Run " +
        runId +
        " ended: " +
        JSON.stringify({ ...status, promptError }),
    );
  }
}
