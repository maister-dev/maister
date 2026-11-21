import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const predecessor = "0361_flow_waits";

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "flow_publication_upgrade" },
    predecessor,
  );
  await declareCurrentTestDatabaseWriter(database);
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("W01 preserves historical publications and checks the new observation's exact owner", async () => {
  const project = await seedProjectRow(database.db);
  const foreign = await seedProjectRow(database.db);
  const runId = randomUUID();
  const attemptId = randomUUID();
  const workspaceId = randomUUID();
  const head = "1".repeat(40);

  await database.pool.query(
    "INSERT INTO runs(id,project_id,status,flow_version,flow_revision) VALUES ($1,$2,'Running','1','revision')",
    [runId, project.id],
  );
  await database.pool.query(
    "INSERT INTO node_attempts(id,run_id,node_id,node_type,status) VALUES ($1,$2,'publish','publish','Running')",
    [attemptId, runId],
  );
  await database.pool.query(
    `INSERT INTO workspaces(id,run_id,project_id,worktree_path,branch,parent_repo_path,published_remote,published_branch,published_at,pr_number,pr_url)
    VALUES ($1,$2,$3,'/seed/worktree','internal','/seed/repo','origin','public/legacy',clock_timestamp(),7,'https://example.test/org/repo/pull/7')`,
    [workspaceId, runId, project.id],
  );

  await expect(
    database.pool.query("SELECT id FROM run_publications"),
  ).rejects.toMatchObject({ code: "42P01" });

  await upgradeMainTestDb(database, predecessor);

  const retained = await database.pool.query(
    "SELECT published_remote,published_branch,pr_number FROM workspaces WHERE id=$1",
    [workspaceId],
  );

  expect(retained.rows).toEqual([
    {
      published_remote: "origin",
      published_branch: "public/legacy",
      pr_number: 7,
    },
  ]);
  expect(
    (await database.pool.query("SELECT id FROM run_publications")).rows,
  ).toEqual([]);
  const insertPublication = (id: string, projectId: string) =>
    database.pool.query(
      `INSERT INTO run_publications
    (id,project_id,run_id,node_attempt_id,workspace_id,operation_key,flow_revision,remote_name,repo_identity,head_ref,base_ref,source_head,pr_mode,phase)
    VALUES ($1,$2,$3,$4,$5,'operation','revision','origin','github:org/repo','refs/heads/public/new','refs/heads/main',$6,'draft','claimed')`,
      [id, projectId, runId, attemptId, workspaceId, head],
    );

  await expect(
    insertPublication(randomUUID(), foreign.id),
  ).rejects.toMatchObject({ code: "23503" });
  const publicationId = randomUUID();

  await insertPublication(publicationId, project.id);
  await expect(
    insertPublication(randomUUID(), project.id),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    database.pool.query(
      `INSERT INTO run_publication_observations
    (id,publication_id,project_id,run_id,kind,source_revision,head_sha,observed_at,fact)
    VALUES ($1,$2,$3,$4,'ci','attempt-1',$5,clock_timestamp(),'{"schemaVersion":1}')`,
      [randomUUID(), publicationId, foreign.id, runId, head],
    ),
  ).rejects.toMatchObject({ code: "23503" });
});
