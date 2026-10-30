import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  listAgentIncidentGroups,
  listAgentIncidentPage,
  acknowledgeAgentEpisodes,
} from "@/lib/runs/agent-incident-projection";
import { computeDecisionsQueue } from "@/lib/queries/decisions";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const priorSecret = process.env.AUTH_SECRET;

vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
}));

beforeAll(async () => {
  process.env.AUTH_SECRET = "incident-projection-test-secret";
  database = await startMainPostgresTestDb({
    databaseName: "agent_incident_projection",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (priorSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = priorSecret;
});

async function seed(): Promise<{
  projectId: string;
  reader: string;
  other: string;
  episodeId: string;
}> {
  const projectId = randomUUID();
  const reader = randomUUID();
  const other = randomUUID();
  const episodeId = randomUUID();

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$1,'Incidents',$2,$3)",
    [projectId, `/unused/${projectId}`, `INC${projectId.slice(0, 8)}`],
  );
  for (const user of [reader, other])
    await database.pool.query(
      "INSERT INTO users(id,email,role) VALUES ($1,$2,'member')",
      [user, `${user}@example.test`],
    );
  for (const user of [reader, other])
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
      [randomUUID(), projectId, user],
    );
  await database.pool.query(
    "INSERT INTO agent_incident_episodes(id,project_id,source_agent_id,scope_key,scope_kind,fingerprint,reason_code) VALUES ($1,$2,'core:scan','unknown','unknown',$3,'runner_unavailable')",
    [episodeId, projectId, "a".repeat(64)],
  );

  return { projectId, reader, other, episodeId };
}

it("IT-UX-08 groups 1,000 failures before queue counting, retains expired evidence, and distinguishes causes from distinct runs and pre-run attempts", async () => {
  const { projectId, reader, other, episodeId } = await seed();

  await database.pool.query(
    "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,original_run_id,channel,observed_at) SELECT $1,'terminal:'||gen_random_uuid()::text,$2,gen_random_uuid()::text,'execution_failure',now() FROM generate_series(1,1000)",
    [episodeId, "a".repeat(64)],
  );
  const causes = Array.from({ length: 12 }, () => randomUUID());

  for (const [index, id] of causes.entries()) {
    await database.pool.query(
      "INSERT INTO agent_incident_episodes(id,project_id,source_agent_id,scope_key,scope_kind,fingerprint,reason_code) VALUES ($1,$2,'core:scan','unknown','unknown',$3,$4)",
      [id, projectId, `${index + 1}`.padStart(64, "0"), `cause_${index}`],
    );
    await database.pool.query(
      "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,original_run_id,channel,observed_at) SELECT $1,'cause:'||$1,$2,original_run_id,'execution_failure',now() FROM agent_incident_occurrences WHERE episode_id=$3 LIMIT 1",
      [id, `${index + 1}`.padStart(64, "0"), episodeId],
    );
  }
  await database.pool.query(
    "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,channel,observed_at) VALUES ($1,'attempt:one',$2,'admission_refusal',now()),($1,'attempt:two',$2,'admission_refusal',now())",
    [episodeId, "a".repeat(64)],
  );
  const groups = await listAgentIncidentGroups(database.db, reader, [
    projectId,
  ]);

  expect(groups).toHaveLength(1);
  const queue = await computeDecisionsQueue(reader, "member", { projectId });

  expect(queue.count).toBe(1);
  expect(queue.items[0]).toMatchObject({
    kind: "operational",
    runId: null,
    operational: { aggregation: "agent", groupId: groups[0].groupId },
  });
  expect(groups[0]).toMatchObject({
    agentId: "core:scan",
    failedRunCount: 1000,
    attemptCount: 2,
    totalCauseCount: 13,
    unreadEpisodeCount: 13,
    representativeRunId: null,
  });
  expect(groups[0].episodes).toHaveLength(10);
  expect(groups[0].nextCursor).not.toBeNull();
  const next = await listAgentIncidentPage(database.db, {
    projectId,
    agentId: "core:scan",
    userId: reader,
    state: "open",
    acknowledged: false,
    cursor: groups[0].nextCursor!,
    limit: 10,
  });

  expect(next.items).toHaveLength(3);
  expect(
    new Set([...groups[0].episodes, ...next.items].map((row) => row.episodeId))
      .size,
  ).toBe(13);
  const initialRevision = groups[0].contentRevision;

  await acknowledgeAgentEpisodes(database.db, {
    projectId,
    agentId: "core:scan",
    userId: reader,
    episodes: [{ episodeId, attentionRevision: 1 }],
  });
  await database.pool.query(
    "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,original_run_id,channel,observed_at) VALUES ($1,'terminal:repeat',$2,$3,'execution_failure',now())",
    [episodeId, "a".repeat(64), randomUUID()],
  );
  const acknowledged = await listAgentIncidentGroups(database.db, reader, [
    projectId,
  ]);

  expect(acknowledged[0]).toMatchObject({
    unreadEpisodeCount: 12,
    totalCauseCount: 13,
    failedRunCount: 1001,
  });
  expect(acknowledged[0].contentRevision).not.toBe(initialRevision);
  expect(
    (await listAgentIncidentGroups(database.db, other, [projectId]))[0]
      .unreadEpisodeCount,
  ).toBe(13);
  await acknowledgeAgentEpisodes(database.db, {
    projectId,
    agentId: "core:scan",
    userId: reader,
    episodes: causes.map((id) => ({ episodeId: id, attentionRevision: 1 })),
  });
  expect(
    await listAgentIncidentGroups(database.db, reader, [projectId]),
  ).toEqual([]);
  expect(await listAgentIncidentGroups(database.db, reader, [])).toEqual([]);
  const history = await listAgentIncidentPage(database.db, {
    projectId,
    agentId: "core:scan",
    userId: reader,
  });

  expect(history.items).toHaveLength(13);
  expect(history.items.every((row) => row.acknowledged)).toBe(true);
});

it("IT-UX-08 validates acknowledgements atomically, preserves legacy tuple semantics and never treats a notification baseline as a reader acknowledgement", async () => {
  const { projectId, reader, episodeId } = await seed();
  const occurrenceId = randomUUID();

  await database.pool.query(
    "INSERT INTO agent_incident_occurrences(id,episode_id,source_fact_key,fingerprint,channel,observed_at) VALUES ($1,$2,'attempt:legacy',$3,'admission_refusal',now())",
    [occurrenceId, episodeId, "a".repeat(64)],
  );
  await database.pool.query(
    "INSERT INTO agent_incident_reader_states(user_id,episode_id,attention_revision,notification_recorded_at,notification_mode) VALUES ($1,$2,1,now(),'baseline')",
    [reader, episodeId],
  );
  expect(
    await listAgentIncidentGroups(database.db, reader, [projectId]),
  ).toHaveLength(1);
  await expect(
    acknowledgeAgentEpisodes(database.db, {
      projectId,
      agentId: "core:scan",
      userId: reader,
      episodes: [
        { episodeId, attentionRevision: 1 },
        { episodeId: randomUUID(), attentionRevision: 1 },
      ],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    (
      await database.pool.query(
        "SELECT acknowledged_at FROM agent_incident_reader_states WHERE user_id=$1 AND episode_id=$2",
        [reader, episodeId],
      )
    ).rows[0].acknowledged_at,
  ).toBeNull();
  await database.pool.query(
    "INSERT INTO agent_incident_occurrence_readers(occurrence_id,user_id,acknowledged_at) VALUES ($1,$2,now())",
    [occurrenceId, reader],
  );
  expect(
    await listAgentIncidentGroups(database.db, reader, [projectId]),
  ).toEqual([]);
  await database.pool.query(
    "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,channel,observed_at) VALUES ($1,'attempt:later',$2,'admission_refusal',now())",
    [episodeId, "a".repeat(64)],
  );
  expect(
    await listAgentIncidentGroups(database.db, reader, [projectId]),
  ).toHaveLength(1);
  await expect(
    acknowledgeAgentEpisodes(database.db, {
      projectId,
      agentId: "core:other",
      userId: reader,
      episodes: [{ episodeId, attentionRevision: 1 }],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    acknowledgeAgentEpisodes(database.db, {
      projectId,
      agentId: "core:scan",
      userId: reader,
      episodes: [{ episodeId, attentionRevision: 2 }],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await database.pool.query(
    "UPDATE agent_incident_episodes SET content_revision=content_revision+1 WHERE id=$1",
    [episodeId],
  );
  const refusal = `refuse_ack_${randomUUID().replaceAll("-", "")}`;

  await database.pool.query(
    `CREATE FUNCTION ${refusal}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='agent.incident_changed' AND NEW.project_id='${projectId}' THEN RAISE EXCEPTION 'Reject test acknowledgement outbox'; END IF; RETURN NEW; END $$`,
  );
  await database.pool.query(
    `CREATE TRIGGER ${refusal} BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION ${refusal}()`,
  );
  try {
    await expect(
      acknowledgeAgentEpisodes(database.db, {
        projectId,
        agentId: "core:scan",
        userId: reader,
        episodes: [{ episodeId, attentionRevision: 1 }],
      }),
    ).rejects.toThrow();
    expect(
      (
        await database.pool.query(
          "SELECT acknowledged_at FROM agent_incident_reader_states WHERE user_id=$1 AND episode_id=$2",
          [reader, episodeId],
        )
      ).rows[0].acknowledged_at,
    ).toBeNull();
  } finally {
    await database.pool.query(`DROP TRIGGER ${refusal} ON domain_events`);
    await database.pool.query(`DROP FUNCTION ${refusal}()`);
  }
  const concurrent = await Promise.all(
    [0, 1].map(() =>
      acknowledgeAgentEpisodes(database.db, {
        projectId,
        agentId: "core:scan",
        userId: reader,
        episodes: [{ episodeId, attentionRevision: 1 }],
      }),
    ),
  );

  expect(concurrent).toEqual([{ acknowledged: 1 }, { acknowledged: 1 }]);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM domain_events WHERE project_id=$1 AND kind='agent.incident_changed'",
        [projectId],
      )
    ).rows[0].count,
  ).toBe(1);
  expect(
    await acknowledgeAgentEpisodes(database.db, {
      projectId,
      agentId: "core:scan",
      userId: reader,
      episodes: [{ episodeId, attentionRevision: 1 }],
    }),
  ).toEqual({ acknowledged: 1 });
  expect(
    await acknowledgeAgentEpisodes(database.db, {
      projectId,
      agentId: "core:scan",
      userId: reader,
      episodes: [{ episodeId, attentionRevision: 1 }],
    }),
  ).toEqual({ acknowledged: 1 });
  expect(
    await listAgentIncidentGroups(database.db, reader, [projectId]),
  ).toEqual([]);
});
