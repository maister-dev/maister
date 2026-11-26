import type { CommandReceipt } from "@/lib/execution-host";

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";

import { canonicalContextProjector } from "@/lib/execution-host/events/context-projector";
import { ingestRuntimeEvent } from "@/lib/execution-host/events/ingest";
import { projectExecutionEvents } from "@/lib/execution-host/events/projector";
import { canonicalTranscriptProjector } from "@/lib/execution-host/events/transcript-projector";
import { parseScratchMessageContent } from "@/lib/run-transcript/transcript";
import {
  seedLocalHost,
  seedProjectRow,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";

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

it("continues 0358 inline compactions with escaped IDs in their original markers", async () => {
  const database = await startMainPostgresTestDbUpTo(
    { databaseName: "acp_context_escaped_id_upgrade" },
    "0358_acp_context",
  );

  try {
    await declareCurrentTestDatabaseWriter(database);
    const { db, pool } = database;
    const { id: projectId } = await seedProjectRow(db);
    const hostBootId = randomUUID();
    const { id: hostId, hostKey } = await seedLocalHost(db, {
      bootId: hostBootId,
    });
    const runId = await seedRun(db, { projectId });
    const assignmentId = randomUUID();
    const hostSessionId = randomUUID();
    const streamId = randomUUID();
    const streamRowId = randomUUID();
    const projectors = [
      canonicalContextProjector,
      canonicalTranscriptProjector,
    ];
    const entries = [
      {
        adapterId: "compact-\uE000",
        oldId: "compact-\uE000E",
        messageId: randomUUID(),
      },
      {
        adapterId: "compact-\uE000E",
        oldId: "compact-\uE000EE",
        messageId: randomUUID(),
      },
    ];

    await pool.query(
      `INSERT INTO execution_assignments(id,run_id,execution_host_id,epoch,state,placement_reason)
       VALUES($1,$2,$3,1,'active','launch')`,
      [assignmentId, runId, hostId],
    );
    await pool.query(
      "UPDATE runs SET execution_assignment_id=$1,next_execution_event_sequence=$3 WHERE id=$2",
      [assignmentId, runId, entries.length],
    );
    await pool.query(
      `INSERT INTO execution_event_streams(
         id,execution_host_id,stream_id,state,last_received_sequence,last_contiguous_sequence,last_boot_id
       ) VALUES($1,$2,$3,'active',$4,$4,$5)`,
      [streamRowId, hostId, streamId, entries.length - 1, hostBootId],
    );
    const ingest = async (
      sequence: number,
      update: Record<string, unknown>,
    ): Promise<string> => {
      const result = await ingestRuntimeEvent({
        db,
        executionHostId: hostId,
        envelope: {
          envelopeVersion: 1,
          eventId: randomUUID(),
          hostKey,
          hostBootId,
          streamId,
          sequence: String(sequence),
          runId,
          assignmentId,
          assignmentEpoch: 1,
          hostSessionId,
          eventType: "session.update",
          occurredAt: "2026-11-20T12:00:00.000Z",
          payloadSchema: "maister.session.update.v1",
          payload: { update },
        },
      });

      expect(result.disposition).toBe("accepted");
      const { rows } = await pool.query<{ sequence: string }>(
        "SELECT run_sequence::text AS sequence FROM execution_events WHERE id=$1",
        [result.eventId],
      );

      return rows[0]!.sequence;
    };
    const scopeHash = createHash("sha256")
      .update(JSON.stringify([hostId, assignmentId, 1, hostSessionId]))
      .digest("hex");
    const starts: string[] = [];

    // Reproduce the 0358 projector output. It used the canonical JSONB
    // representation of the adapter ID directly as its storage identity.
    for (const [index, entry] of entries.entries()) {
      const start = String(index);
      const payload = JSON.stringify({
        update: {
          sessionUpdate: "compaction_update",
          compactionId: entry.oldId,
          status: "in_progress",
        },
      });
      const payloadHash = createHash("sha256").update(payload).digest("hex");
      const oldIdHash = createHash("sha256").update(entry.oldId).digest("hex");

      await pool.query(
        `INSERT INTO execution_events(
           id,source,run_id,execution_host_id,event_stream_id,host_sequence,
           execution_assignment_id,assignment_epoch,host_boot_id,host_session_id,
           envelope_version,event_type,payload_schema,payload,payload_sha256,payload_bytes,
           occurred_at,run_sequence,ingest_disposition
         ) VALUES($1,'host',$2,$3,$4,$5,$6,1,$7,$8,1,'session.update',
                  'maister.session.update.v1',$9,$10,$11,now(),$5,'accepted')`,
        [
          randomUUID(),
          runId,
          hostId,
          streamRowId,
          start,
          assignmentId,
          hostBootId,
          hostSessionId,
          payload,
          payloadHash,
          Buffer.byteLength(payload),
        ],
      );
      starts.push(start);
      await pool.query(
        `INSERT INTO run_context_compactions(
           run_id,execution_host_id,assignment_id,assignment_epoch,host_session_id,
           compaction_id,status,first_run_sequence,last_run_sequence,started_at,before_usage
         ) VALUES($1,$2,$3,1,$4,$5,'in_progress',$6,$6,now(),'{"used":80,"size":100}')`,
        [runId, hostId, assignmentId, hostSessionId, entry.oldId, start],
      );
      await pool.query(
        `INSERT INTO run_messages(
           id,run_id,role,content,sequence,first_supervisor_event_id,supervisor_event_id,projection_tool_key
         ) VALUES($1,$2,'system',$3,$4,$5,$5,$6)`,
        [
          entry.messageId,
          runId,
          JSON.stringify({
            v: 1,
            kind: "compaction",
            status: "in_progress",
            summary: `Start ${index}`,
          }),
          index + 1,
          start,
          `compaction:${scopeHash}:${oldIdHash}`,
        ],
      );
    }
    await pool.query(
      `INSERT INTO execution_event_consumers(consumer_name,run_id,last_run_sequence)
       SELECT unnest($1::text[]),$2,$3
       ON CONFLICT (consumer_name,run_id) DO UPDATE SET last_run_sequence=excluded.last_run_sequence`,
      [
        projectors.map(({ consumerName }) => consumerName),
        runId,
        starts.at(-1),
      ],
    );

    await upgradeMainTestDb(database, "0358_acp_context");

    const firstId = entries[0]!.adapterId;

    await ingest(2, {
      sessionUpdate: "compaction_summary_chunk",
      compactionId: firstId,
      content: { type: "text", text: " continued" },
    });
    const terminal = await ingest(3, {
      sessionUpdate: "compaction_update",
      compactionId: firstId,
      status: "completed",
    });

    for (const projector of projectors)
      await expect(
        projectExecutionEvents({ db, projector, runId }),
      ).resolves.toMatchObject({
        poisoned: false,
        deferred: false,
        lastRunSequence: terminal,
      });

    const messages = await pool.query<{
      id: string;
      sequence: number;
      first_supervisor_event_id: string;
      supervisor_event_id: string;
      content: string;
    }>(
      `SELECT id,sequence,first_supervisor_event_id,supervisor_event_id,content
        FROM run_messages WHERE run_id=$1 ORDER BY sequence`,
      [runId],
    );

    expect(
      messages.rows.map(({ content, ...row }) => ({
        ...row,
        marker: parseScratchMessageContent("system", content),
      })),
    ).toEqual([
      {
        id: entries[0]!.messageId,
        sequence: 1,
        first_supervisor_event_id: starts[0],
        supervisor_event_id: terminal,
        marker: {
          v: 1,
          kind: "compaction",
          status: "completed",
          summary: "Start 0 continued",
        },
      },
      {
        id: entries[1]!.messageId,
        sequence: 2,
        first_supervisor_event_id: starts[1],
        supervisor_event_id: starts[1],
        marker: {
          v: 1,
          kind: "compaction",
          status: "in_progress",
          summary: "Start 1",
        },
      },
    ]);
    const counts = await pool.query(
      `SELECT active_compactions,completed_compactions FROM run_context_usage WHERE run_id=$1`,
      [runId],
    );

    expect(counts.rows).toEqual([
      { active_compactions: 1, completed_compactions: 1 },
    ]);
    const lifecycle = await pool.query(
      `SELECT compaction_id,status,before_usage,first_run_sequence,last_run_sequence
       FROM run_context_compactions WHERE run_id=$1 ORDER BY first_run_sequence`,
      [runId],
    );

    expect(lifecycle.rows).toEqual(
      entries.map(({ adapterId }, index) => ({
        compaction_id: adapterId,
        status: index === 0 ? "completed" : "in_progress",
        before_usage: { used: 80, size: 100 },
        first_run_sequence: starts[index],
        last_run_sequence: index === 0 ? terminal : starts[index],
      })),
    );
  } finally {
    await database.stop();
  }
}, 180_000);

it("materializes existing observations, compaction counts and marker watermarks by scope", async () => {
  const db = await startMainPostgresTestDbUpTo(
    { databaseName: "acp_context_projection_upgrade" },
    "0358_acp_context",
  );

  try {
    await declareCurrentTestDatabaseWriter(db);
    const runId = randomUUID();
    const attemptId = randomUUID();
    const { id: projectId } = await seedProjectRow(db.db);

    await seedRun(db.db, { id: runId, projectId, runKind: "flow" });
    await db.pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type) VALUES($1,$2,'fixture','ai_coding')",
      [attemptId, runId],
    );
    await db.pool.query(
      `INSERT INTO run_context_usage(
         run_id,execution_host_id,assignment_id,assignment_epoch,host_session_id,node_attempt_id,
         used_tokens,size_tokens,observed_at,usage_run_sequence,last_run_sequence
       ) VALUES($1,'host','assignment',1,'session',$2,80,100,now(),4,4)`,
      [runId, attemptId],
    );
    await db.pool.query(
      `INSERT INTO run_context_compactions(
         run_id,execution_host_id,assignment_id,assignment_epoch,host_session_id,
         node_attempt_id,compaction_id,status,first_run_sequence,last_run_sequence,started_at,ended_at
       ) VALUES
         ($1,'host','assignment',1,'session',$2,'first','completed',5,6,now(),now()),
         ($1,'host','assignment',1,'session',NULL,'second','in_progress',7,7,now(),NULL)`,
      [runId, attemptId],
    );
    await db.pool.query(
      `INSERT INTO run_messages(id,run_id,node_attempt_id,role,content,sequence,supervisor_event_id,projection_tool_key)
       VALUES($1,$2,$3,'system','{}',1,'6','compaction:first'),
             ($4,$2,NULL,'system','{}',2,'7','compaction:second')`,
      [randomUUID(), runId, attemptId, randomUUID()],
    );

    await applyMainMigration(db.db, "0359_acp_context_projection_state");

    const counts = await db.pool.query(
      `SELECT node_attempt_id,used_tokens,last_run_sequence,
              active_compactions,completed_compactions,compaction_run_sequence
        FROM run_context_usage WHERE run_id=$1 ORDER BY node_attempt_id NULLS FIRST`,
      [runId],
    );

    expect(counts.rows).toEqual([
      {
        node_attempt_id: null,
        used_tokens: null,
        last_run_sequence: "0",
        active_compactions: 1,
        completed_compactions: 1,
        compaction_run_sequence: "7",
      },
      {
        node_attempt_id: attemptId,
        used_tokens: "80",
        last_run_sequence: "4",
        active_compactions: 0,
        completed_compactions: 1,
        compaction_run_sequence: "6",
      },
    ]);
    const revisions = await db.pool.query(
      `SELECT node_attempt_id,revision,last_run_sequence FROM run_context_transcript_revisions
       WHERE run_id=$1 ORDER BY node_attempt_id NULLS FIRST`,
      [runId],
    );

    expect(revisions.rows).toEqual([
      { node_attempt_id: null, revision: "1", last_run_sequence: "7" },
      { node_attempt_id: attemptId, revision: "1", last_run_sequence: "6" },
    ]);
  } finally {
    await db.stop();
  }
}, 180_000);
