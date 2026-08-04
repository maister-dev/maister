import type { NodeAttempt, Run } from "@/lib/db/schema";

import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";
import {
  schema,
  seedGraphRun as seedGraphRunShared,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

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

// Shared seeding with flows/flow_revisions installedPath at the local
// fixture dir (7e981b3c pattern).
function seedGraphRun(manifest: unknown): Promise<SeededGraphRun> {
  return seedGraphRunShared(db, manifest, {
    flowRefId: "flow-dir",
    installedPath: FIXTURE_PATH,
    flowRevision: true,
  });
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
      // ADR-154 floor gate: MAISTER_FLOW_DIR in the check command requires 3.3.0.
      compat: { engine_min: "3.3.0" },
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
