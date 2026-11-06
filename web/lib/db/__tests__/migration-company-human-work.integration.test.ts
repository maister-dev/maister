import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let projectId: string;
let userId: string;
let actorId: string;
let companyId: string;
let retained: Readonly<Record<string, unknown>>[];

async function retainedProjectRows(): Promise<
  Readonly<Record<string, unknown>>[]
> {
  return (
    await database.pool.query(
      "SELECT * FROM (SELECT 'actor' AS kind,to_jsonb(a)-'company_id' AS value FROM actor_identities a UNION ALL SELECT 'assignment',to_jsonb(a)-'company_id' FROM assignments a UNION ALL SELECT 'event',to_jsonb(a)-'company_id' FROM assignment_events a) retained ORDER BY kind,value->>'id'",
    )
  ).rows;
}

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "company_human_work_upgrade" },
    "0243_native_source_array_planning",
  );
  projectId = (await seedProjectRow(database.db)).id;
  userId = randomUUID();
  actorId = randomUUID();
  companyId = (await database.pool.query("SELECT id FROM companies")).rows[0]
    .id;
  const runId = randomUUID();
  const assignmentId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision) VALUES($1,$2,'agent','Pending','fixture','fixture')",
    [runId, projectId],
  );
  await database.pool.query(
    "INSERT INTO actor_identities(id,project_id,kind,label,user_id) VALUES($1,$2,'user','Retained operator',$3)",
    [actorId, projectId, userId],
  );
  await database.pool.query(
    "INSERT INTO assignments(id,project_id,run_id,action_kind,status,title,assignee_actor_id,claimed_at) VALUES($1,$2,$3,'permission','claimed','Retained decision',$4,now())",
    [assignmentId, projectId, runId, actorId],
  );
  await database.pool.query(
    "INSERT INTO assignment_events(id,assignment_id,project_id,run_id,event_kind,actor_id,to_status) VALUES($1,$2,$3,$4,'claimed',$5,'claimed')",
    [randomUUID(), assignmentId, projectId, runId, actorId],
  );
  retained = await retainedProjectRows();
  await applyMainMigration(database.db, "0244_company_human_work_ownership");
  await applyMainMigration(database.db, "0245_human_work_owner_guards");
}, 180000);

afterAll(async () => {
  await database?.stop();
});

it("preserves populated project actors, human claims and events without inventing company ownership", async () => {
  expect(await retainedProjectRows()).toEqual(retained);
  expect(
    (
      await database.pool.query(
        "SELECT (SELECT count(*) FROM actor_identities WHERE company_id IS NOT NULL)+(SELECT count(*) FROM assignments WHERE company_id IS NOT NULL)+(SELECT count(*) FROM assignment_events WHERE company_id IS NOT NULL) AS count",
      )
    ).rows[0],
  ).toEqual({ count: "0" });
  const companyActor = randomUUID();

  await database.pool.query(
    "INSERT INTO actor_identities(id,company_id,kind,label,user_id) VALUES($1,$2,'user','Company operator',$3)",
    [companyActor, companyId, userId],
  );
  await expect(
    database.pool.query(
      "INSERT INTO actor_identities(id,company_id,kind,label,user_id) VALUES($1,$2,'user','Duplicate',$3)",
      [randomUUID(), companyId, userId],
    ),
  ).rejects.toMatchObject({
    code: "23505",
    constraint: "actor_identities_company_user_uq",
  });
  await expect(
    database.pool.query(
      "INSERT INTO actor_identities(id,company_id,project_id,kind,label,user_id) VALUES($1,$2,$3,'user','Ambiguous',$4)",
      [randomUUID(), companyId, projectId, userId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "actor_identities_owner_shape",
  });
  await expect(
    database.pool.query(
      "INSERT INTO actor_identities(id,company_id,kind,label,token_id) VALUES($1,$2,'api_token','Unsupported token',$3)",
      [randomUUID(), companyId, randomUUID()],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "actor_identities_company_kind",
  });
  await expect(
    database.pool.query(
      "UPDATE actor_identities SET project_id=$2,company_id=NULL WHERE id=$1",
      [companyActor, projectId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "human_actor_owner_immutable",
  });
  const otherUser = randomUUID();

  await database.pool.query("INSERT INTO users(id,email) VALUES($1,$2)", [
    otherUser,
    `${otherUser}@example.test`,
  ]);
  await expect(
    database.pool.query("UPDATE actor_identities SET user_id=$2 WHERE id=$1", [
      companyActor,
      otherUser,
    ]),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "human_actor_principal_immutable",
  });
  await database.pool.query("DELETE FROM users WHERE id=$1", [userId]);
  expect(
    (
      await database.pool.query(
        "SELECT user_id,company_id,project_id FROM actor_identities WHERE id=$1",
        [companyActor],
      )
    ).rows[0],
  ).toEqual({ user_id: null, company_id: companyId, project_id: null });
  await database.pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
  expect(
    (await database.pool.query("SELECT count(*) AS count FROM assignments"))
      .rows[0],
  ).toEqual({ count: "0" });
  expect(
    (
      await database.pool.query(
        "SELECT count(*) AS count FROM assignment_events",
      )
    ).rows[0],
  ).toEqual({ count: "0" });
  expect(
    (
      await database.pool.query(
        "SELECT count(*) AS count FROM actor_identities WHERE id=$1",
        [companyActor],
      )
    ).rows[0],
  ).toEqual({ count: "1" });
});
