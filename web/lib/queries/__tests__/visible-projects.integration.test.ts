// IT-STG-09 (ADR-170 / D6) — the ONE visible-projects helper the cross-project
// read models scope by. The admin/member branch was inlined three times before
// this; five more copies were about to be written.
//
// Both directions are asserted. A deny-only suite cannot tell "correctly
// refused" from "returns nothing because it is broken", so every case here is
// paired with a positive grant that must be non-empty.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

import { getVisibleProjectIds } from "@/lib/queries/visible-projects";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const fx = {
  member: randomUUID(),
  stranger: randomUUID(),
  admin: randomUUID(),
  // Owned by `member`.
  projectOwn: randomUUID(),
  projectAlsoOwn: randomUUID(),
  // `member` is NOT a member of this one.
  projectForeign: randomUUID(),
  // `member` IS a member, but it is archived.
  projectArchived: randomUUID(),
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "visible_projects_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  for (const [projectId, slug, key] of [
    [fx.projectOwn, "vp-own", "VPO"],
    [fx.projectAlsoOwn, "vp-also", "VPA"],
    [fx.projectForeign, "vp-foreign", "VPF"],
    [fx.projectArchived, "vp-archived", "VPX"],
  ] as const) {
    await pool.query(
      `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
       values ($1, $2, $2, $3, '/tmp/m.yaml', $4)`,
      [projectId, slug, `/tmp/${slug}`, key],
    );
  }
  await pool.query(`update projects set archived_at = now() where id = $1`, [
    fx.projectArchived,
  ]);

  for (const [userId, email, role] of [
    [fx.member, "vp-member@test.local", "member"],
    [fx.stranger, "vp-stranger@test.local", "member"],
    [fx.admin, "vp-admin@test.local", "admin"],
  ] as const) {
    await pool.query(
      `insert into users (id, email, role) values ($1, $2, $3)`,
      [userId, email, role],
    );
  }

  // The admin deliberately belongs to NO project: an admin's reach must come
  // from the role, not from membership, or the admin branch is untested.
  for (const [projectId, userId] of [
    [fx.projectOwn, fx.member],
    [fx.projectAlsoOwn, fx.member],
    [fx.projectArchived, fx.member],
    [fx.projectForeign, fx.stranger],
  ] as const) {
    await pool.query(
      `insert into project_members (id, project_id, user_id, role)
       values ($1, $2, $3, 'member')`,
      [randomUUID(), projectId, userId],
    );
  }
});

afterAll(async () => {
  await testDatabase?.stop();
});

describe("IT-STG-09 getVisibleProjectIds — member scope", () => {
  it("returns exactly the member's own non-archived projects", async () => {
    const ids = await getVisibleProjectIds(fx.member, "member");

    expect([...ids].sort()).toEqual([fx.projectOwn, fx.projectAlsoOwn].sort());
  });

  it("grants at least one project, so a passing deny case means something", async () => {
    const ids = await getVisibleProjectIds(fx.member, "member");

    expect(ids.length).toBeGreaterThan(0);
  });

  it("omits a project the member does not belong to", async () => {
    const ids = await getVisibleProjectIds(fx.member, "member");

    expect(ids).not.toContain(fx.projectForeign);
  });

  it("omits an archived project the member does belong to", async () => {
    const ids = await getVisibleProjectIds(fx.member, "member");

    expect(ids).not.toContain(fx.projectArchived);
  });

  it("returns an empty list for a user with no memberships", async () => {
    const orphan = randomUUID();

    await pool.query(`insert into users (id, email) values ($1, $2)`, [
      orphan,
      `vp-${orphan}@test.local`,
    ]);

    expect(await getVisibleProjectIds(orphan, "member")).toEqual([]);
  });
});

describe("IT-STG-09 getVisibleProjectIds — admin scope", () => {
  it("returns every non-archived project, including ones the admin never joined", async () => {
    const ids = await getVisibleProjectIds(fx.admin, "admin");

    expect(ids).toContain(fx.projectOwn);
    expect(ids).toContain(fx.projectAlsoOwn);
    expect(ids).toContain(fx.projectForeign);
  });

  it("still omits archived projects", async () => {
    const ids = await getVisibleProjectIds(fx.admin, "admin");

    expect(ids).not.toContain(fx.projectArchived);
  });

  it("sees strictly more than the member does", async () => {
    const adminIds = await getVisibleProjectIds(fx.admin, "admin");
    const memberIds = await getVisibleProjectIds(fx.member, "member");

    expect(adminIds.length).toBeGreaterThan(memberIds.length);
  });
});

describe("IT-STG-09 getVisibleProjectIds — viewer scope", () => {
  it("scopes a global viewer by membership, exactly like a member", async () => {
    const asViewer = await getVisibleProjectIds(fx.member, "viewer");
    const asMember = await getVisibleProjectIds(fx.member, "member");

    expect([...asViewer].sort()).toEqual([...asMember].sort());
  });
});
