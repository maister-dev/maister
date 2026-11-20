import type { CommandReceipt } from "@/lib/execution-host";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";

import {
  seedLocalHost,
  seedProjectRow,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

it("upgrades a populated predecessor while preserving old attempt and transcript evidence", async () => {
  const db = await startMainPostgresTestDbUpTo(
    { databaseName: "acp_context_upgrade" },
    "0357_agent_continuation_episodes",
  );

  try {
    await declareCurrentTestDatabaseWriter(db);
    const runId = randomUUID();
    const attemptId = randomUUID();
    const messageId = randomUUID();
    const sessionId = randomUUID();
    const hostSessionId = randomUUID();
    const assignmentId = randomUUID();
    const commandId = randomUUID();
    const acpSessionId = "retained-acp-session";
    const checkpointRef = `refs/maister/checkpoints/${runId}/${attemptId}`;
    const projectId = (await seedProjectRow(db.db)).id;
    const { id: hostId } = await seedLocalHost(db.db);

    await seedRun(db.db, { id: runId, projectId, runKind: "flow" });
    await db.pool.query(
      `INSERT INTO node_attempts(id,run_id,node_id,node_type,status,error_code,checkpoint_ref,acp_session_id)
       VALUES($1,$2,'fixture','ai_coding','Failed','ACP_PROTOCOL',$3,$4)`,
      [attemptId, runId, checkpointRef, acpSessionId],
    );
    await db.pool.query(
      `INSERT INTO execution_assignments(id,run_id,execution_host_id,epoch,state,placement_reason)
       VALUES($1,$2,$3,1,'active','launch')`,
      [assignmentId, runId, hostId],
    );
    await db.pool.query(
      `INSERT INTO run_sessions(id,run_id,session_name,execution_assignment_id,host_session_id,acp_session_id)
       VALUES($1,$2,'orchestrator',$3,$4,$5)`,
      [sessionId, runId, assignmentId, hostSessionId, acpSessionId],
    );
    const receipt: CommandReceipt = {
      commandId,
      runId,
      kind: "session.checkpoint",
      assignmentEpoch: 1,
      phase: "completed",
      httpStatus: 200,
      body: { acpSessionId },
      receivedAt: "2026-11-20T12:00:00.000Z",
      completedAt: "2026-11-20T12:00:01.000Z",
      eventId: null,
      inflight: false,
    };

    await db.pool.query(
      `INSERT INTO execution_commands(id,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,target_session_id,max_attempts,state,completed_at,receipt_evidence)
       VALUES($1,$2,$3,$4,1,'session.checkpoint',$5,1,'succeeded',$6,$7)`,
      [
        commandId,
        runId,
        assignmentId,
        hostId,
        hostSessionId,
        receipt.completedAt,
        receipt,
      ],
    );
    const content = JSON.stringify({
      v: 1,
      kind: "usage",
      used: 80,
      size: 100,
    });

    await db.pool.query(
      "INSERT INTO run_messages (id,run_id,node_attempt_id,role,content,sequence,first_supervisor_event_id,supervisor_event_id) VALUES($1,$2,$3,'system',$4,1,'4','5')",
      [messageId, runId, attemptId, content],
    );
    const migrationsFolder = "./lib/db/migrations";
    const journal = JSON.parse(
      await readFile(`${migrationsFolder}/meta/_journal.json`, "utf8"),
    ) as {
      entries: { tag: string; when: number }[];
    };
    const cutoff = journal.entries.find(
      ({ tag }) => tag === "0357_agent_continuation_episodes",
    )?.when;

    if (!cutoff) throw new Error("missing context migration predecessor");
    const applied = readMigrationFiles({ migrationsFolder }).filter(
      ({ folderMillis }) => folderMillis <= cutoff,
    );

    await db.pool.query(
      "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    await db.pool.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT * FROM unnest($1::text[],$2::bigint[])",
      [
        applied.map((migration) => migration.hash),
        applied.map((migration) => migration.folderMillis),
      ],
    );
    await migrate(db.db, { migrationsFolder });
    await migrate(db.db, { migrationsFolder });

    expect(
      (
        await db.pool.query(
          "SELECT error_code,error_reason,checkpoint_ref,acp_session_id FROM node_attempts WHERE id=$1",
          [attemptId],
        )
      ).rows,
    ).toEqual([
      {
        error_code: "ACP_PROTOCOL",
        error_reason: null,
        checkpoint_ref: checkpointRef,
        acp_session_id: acpSessionId,
      },
    ]);
    expect(
      (
        await db.pool.query(
          "SELECT session_name,host_session_id,acp_session_id FROM run_sessions WHERE id=$1 AND execution_assignment_id=$2",
          [sessionId, assignmentId],
        )
      ).rows,
    ).toEqual([
      {
        session_name: "orchestrator",
        host_session_id: hostSessionId,
        acp_session_id: acpSessionId,
      },
    ]);
    expect(
      (
        await db.pool.query(
          "SELECT receipt_evidence FROM execution_commands WHERE id=$1",
          [commandId],
        )
      ).rows,
    ).toEqual([{ receipt_evidence: receipt }]);
    expect(
      (
        await db.pool.query(
          "SELECT content,first_supervisor_event_id,supervisor_event_id FROM run_messages WHERE id=$1",
          [messageId],
        )
      ).rows,
    ).toEqual([
      { content, first_supervisor_event_id: "4", supervisor_event_id: "5" },
    ]);
    await expect(
      db.pool.query(
        "INSERT INTO run_context_usage(run_id, execution_host_id, assignment_id, assignment_epoch, host_session_id, used_tokens, last_run_sequence) VALUES($1,'host','assignment',1,'session',0,1)",
        [runId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  } finally {
    await db.stop();
  }
}, 180_000);
