import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { loadC2CandidateRows } from "@/lib/scheduler/c2-eligibility";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import {
  applyTriageVerdict,
  sendTaskToTriageInTransaction,
} from "@/lib/services/triage";
import { seedActiveUser } from "@/test-support/librarian-seed";
import { seedProject } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;
type Intent = null | "none" | "triage_only" | "triage_then_launch";

let database: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;
let flowId: string;
let userId: string;
let nextNumber = 0;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "launch_intent" });
  db = database.db;
  projectId = await seedProject(db);
  userId = await seedActiveUser(db);
  flowId = randomUUID();
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function seedTask(intent: Intent): Promise<string> {
  const taskId = randomUUID();
  nextNumber += 1;
  await db.execute(sql`
    INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, launch_intent)
    VALUES (${taskId}, ${projectId}, ${nextNumber}, 'Triage intent', 'p', ${flowId}, ${intent})
  `);
  return taskId;
}

describe("D8 launch intent", () => {
  it.each([
    [null, false, null],
    [null, true, "auto"],
    ["none", false, null],
    ["none", true, null],
    ["triage_only", false, null],
    ["triage_only", true, null],
    ["triage_then_launch", false, null],
    ["triage_then_launch", true, "auto"],
  ] as const)(
    "IT-LOP-06: intent %s, enqueue %s => %s",
    async (intent, enqueue, expectedMode) => {
      const taskId = await seedTask(intent);
      await db.transaction(async (tx) => {
        await applyTriageVerdict(tx, {
          taskId,
          projectId,
          verdict: { flowId },
          actor: { type: "user", id: userId },
          enqueue,
        });
      });

      const rows = await db.execute(sql`
      SELECT launch_mode, launch_armed_at FROM tasks WHERE id = ${taskId}
    `);
      expect(rows.rows[0]?.launch_mode).toBe(expectedMode);
      expect(rows.rows[0]?.launch_armed_at === null).toBe(
        expectedMode === null,
      );
    },
  );

  it("IT-LOP-05 IT-EDGE-LOP-04: intent none survives triage and C2 refuses even a stale auto arm", async () => {
    const taskId = await seedTask("none");
    await db.transaction(async (tx) => {
      await applyTriageVerdict(tx, {
        taskId,
        projectId,
        verdict: { flowId },
        actor: { type: "user", id: userId },
        enqueue: true,
      });
    });
    await db.execute(
      sql`UPDATE tasks SET launch_mode = NULL WHERE id <> ${taskId}`,
    );
    await db.execute(
      sql`UPDATE tasks SET launch_mode = 'auto' WHERE id = ${taskId}`,
    );

    const candidates = await loadC2CandidateRows(db);
    expect(candidates).toHaveLength(0);

    const tick = await runSchedulerTick({ jobKind: "auto_launch_triaged" });
    expect(tick).toMatchObject({ failedCount: 0 });
    const runs = await db.execute(
      sql`SELECT id FROM runs WHERE task_id = ${taskId}`,
    );
    expect(runs.rows).toHaveLength(0);
  });

  it("IT-LOP-06: send-to-triage writes intent, clears old arm, and emits requeue atomically", async () => {
    const taskId = await seedTask("none");
    await db.execute(
      sql`UPDATE tasks SET triage_status = 'triaged', launch_mode = 'auto' WHERE id = ${taskId}`,
    );

    await db.transaction(async (tx) => {
      await sendTaskToTriageInTransaction(tx, {
        taskId,
        projectId,
        taskRef: "EH-1",
        title: "Triage intent",
        actor: { type: "user", id: userId },
        launchIntent: "triage_then_launch",
      });
    });

    const rows = await db.execute(sql`
      SELECT launch_intent, launch_mode, triage_status FROM tasks WHERE id = ${taskId}
    `);
    expect(rows.rows[0]).toMatchObject({
      launch_intent: "triage_then_launch",
      launch_mode: null,
      triage_status: null,
    });
    const events = await db.execute(sql`
      SELECT id FROM domain_events WHERE task_id = ${taskId} AND kind = 'task.triage_requeued'
    `);
    expect(events.rows).toHaveLength(1);
  });
});
