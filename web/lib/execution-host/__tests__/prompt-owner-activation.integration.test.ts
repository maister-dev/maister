// S2.12 — mandatory-owner activation. The database, not a caller convention,
// is what rejects an unowned prompt after activation; these cases pin that
// boundary and the classification of the pre-v2 rows the upgrade preserved.

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { retireEligibleCommands } from "@/lib/execution-host/retirement";
import {
  seedLocalHost,
  seedProject,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let projectId: string;
let hostId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_owner_activation",
  });
  db = testDatabase.db as unknown as Db;
  projectId = await seedProject(testDatabase.db);
  hostId = (await seedLocalHost(testDatabase.db)).id;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedAssignment() {
  const runId = await seedRun(testDatabase.db, { projectId });
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
  );

  return { runId, assignment };
}

// The raw column list an old writer would have used: no owner, no request
// identity. Going through the pool rather than the client is the point — this
// is what a binary from before activation does.
async function insertPromptRow(opts: {
  runId: string;
  assignmentId: string;
  epoch: number;
  ownerKind?: string | null;
}) {
  const id = randomUUID();

  await testDatabase.pool.query(
    `insert into execution_commands
       (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch,
        kind, target_session_id, payload, max_attempts, owner_kind, owner_ref,
        logical_operation_key, request_schema, request_sha256)
     values ($1, $2, $3, $4, $5, 'session.prompt', $6, '{}'::jsonb, 3, $7, $8, $9, $10, $11)`,
    [
      id,
      opts.runId,
      opts.assignmentId,
      hostId,
      opts.epoch,
      randomUUID(),
      opts.ownerKind ?? null,
      opts.ownerKind
        ? JSON.stringify({
            version: 1,
            variant: "node",
            nodeAttemptId: randomUUID(),
            promptOrdinal: 0,
            runId: opts.runId,
            runSessionId: randomUUID(),
            incarnationId: randomUUID(),
            assignmentId: opts.assignmentId,
            assignmentEpoch: opts.epoch,
          })
        : null,
      opts.ownerKind ? `flow_node_attempt:node:${id}:0` : null,
      opts.ownerKind ? "maister.command.request.v1" : null,
      opts.ownerKind ? "c".repeat(64) : null,
    ],
  );

  return id;
}

describe("S2.12 mandatory prompt-owner activation", () => {
  it("rejects an unowned prompt row from any writer, not just the typed client", async () => {
    const { runId, assignment } = await seedAssignment();

    await expect(
      insertPromptRow({
        runId,
        assignmentId: assignment.id,
        epoch: assignment.epoch,
      }),
    ).rejects.toMatchObject({
      constraint: "execution_commands_prompt_owner_required",
    });
  }, 60_000);

  it("accepts an owned prompt row through the same boundary", async () => {
    const { runId, assignment } = await seedAssignment();
    const id = await insertPromptRow({
      runId,
      assignmentId: assignment.id,
      epoch: assignment.epoch,
      ownerKind: "flow_node_attempt",
    });
    const [row] = await db
      .select({ ownerKind: schema.executionCommands.ownerKind })
      .from(schema.executionCommands)
      .where(eq(schema.executionCommands.id, id));

    expect(row.ownerKind).toBe("flow_node_attempt");
  }, 60_000);

  it("rejects an update that strips the owner off an existing prompt", async () => {
    const { runId, assignment } = await seedAssignment();
    const id = await insertPromptRow({
      runId,
      assignmentId: assignment.id,
      epoch: assignment.epoch,
      ownerKind: "flow_node_attempt",
    });

    await expect(
      testDatabase.pool.query(
        "update execution_commands set owner_kind = null, owner_ref = null, logical_operation_key = null, request_schema = null, request_sha256 = null where id = $1",
        [id],
      ),
    ).rejects.toMatchObject({
      constraint: "execution_commands_prompt_owner_required",
    });
  }, 60_000);

  it("classifies a preserved pre-activation row as unowned rather than as an undischarged owner", async () => {
    const { runId, assignment } = await seedAssignment();
    const id = randomUUID();

    // The upgrade preserves pre-v2 history unreconstructed, so the NOT VALID
    // constraint must not stand in the way of a row that predates it.
    await testDatabase.pool.query(
      "alter table execution_commands drop constraint execution_commands_prompt_owner_required",
    );
    try {
      await insertPromptRow({
        runId,
        assignmentId: assignment.id,
        epoch: assignment.epoch,
      });
      await testDatabase.pool.query(
        "update execution_commands set state = 'succeeded', completed_at = now() - interval '400 days' where run_id = $1",
        [runId],
      );
      await testDatabase.pool.query(
        "update runs set status = 'Done' where id = $1",
        [runId],
      );

      const summary = await retireEligibleCommands({
        db,
        hosts: createExecutionHosts({ db }),
      });

      expect(summary.reasons.pre_activation_unowned).toBeGreaterThanOrEqual(1);
      expect(summary.reasons.owner_unapplied ?? 0).toBe(0);
      expect(summary.retired).toBe(0);
    } finally {
      await testDatabase.pool.query(
        "delete from execution_commands where run_id = $1",
        [runId],
      );
      await testDatabase.pool.query(
        `alter table execution_commands add constraint execution_commands_prompt_owner_required
         check (kind <> 'session.prompt' or owner_kind is not null) not valid`,
      );
      void id;
    }
  }, 120_000);
});
