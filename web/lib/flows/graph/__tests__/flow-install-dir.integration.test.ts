import type { NodeAttempt, Run } from "@/lib/db/schema";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { closeDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

// ADR-154: a check node's command executes a script file shipped INSIDE the
// installed flow revision via the injected MAISTER_FLOW_DIR — the seam the
// env-e2e package stands on. The fixture's installedPath doubles as the
// injected value; the `:?` guard is the same idiom packages use, so on an
// engine without the injection this fails loudly (run Failed), not silently.

const FIXTURE_PATH = resolve(__dirname, "_fixtures/flow-install-dir");

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await testDatabase?.stop();
});

type Seeded = { runId: string; runtimeRoot: string };

// Mirrors node-output.integration.test.ts seeding: flows/flow_revisions rows
// whose installedPath points at the local fixture dir (7e981b3c pattern).
async function seedGraphRun(manifest: unknown): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "flow-dir",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: FIXTURE_PATH,
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "flow-dir",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: randomUUID().replace(/-/g, ""),
    manifestDigest: "test-digest",
    manifest,
    schemaVersion: 1,
    installedPath: FIXTURE_PATH,
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId,
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, runtimeRoot };
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

describe("runGraph — MAISTER_FLOW_DIR packaged-script execution (ADR-154)", () => {
  it("a check node executes a file from the flow install dir", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "flow-dir",
      compat: { engine_min: "3.0.0" },
      nodes: [
        {
          id: "verify",
          type: "check",
          action: {
            command:
              'bash "${MAISTER_FLOW_DIR:?engine lacks MAISTER_FLOW_DIR}/scripts/hello.sh"',
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const verify = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "verify",
    );

    expect(verify?.status).toBe("Succeeded");
    expect(verify?.stdout ?? "").toContain("flow-dir-script-ran");
  }, 60_000);
});
