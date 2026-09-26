import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-181 migration `0179_workbench_git_publication`: the publication triple on
// `workspaces` and the public-branch template on `projects`. Seeded on the
// PRE-migration schema and replayed, so the defaults are proven on rows that
// existed before the columns did — not only on rows a post-migration writer
// inserts.

type Db = NodePgDatabase;

let testDatabase: StartedPostgresTestDb;
let db: Db;

const projectId = randomUUID();
const runId = randomUUID();
const workspaceId = randomUUID();

async function one<T extends Record<string, unknown>>(
  query: ReturnType<typeof sql>,
): Promise<T> {
  const result = await db.execute(query);

  expect(result.rows).toHaveLength(1);

  return result.rows[0] as T;
}

async function refusal(query: ReturnType<typeof sql>): Promise<string> {
  try {
    await db.execute(query);
  } catch (err) {
    return String((err as { constraint?: string }).constraint ?? err);
  }
  throw new Error("expected the statement to be refused");
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "maister_migration_0179_test" },
    "0178_host_span_verdict",
  );
  db = testDatabase.db;

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (${projectId}, 'mig-0179', 'mig-0179', '/tmp/mig-0179', 'MIG0179')
  `);
  await db.execute(sql`
    INSERT INTO runs (id, project_id, status, run_kind, flow_version)
    VALUES (${runId}, ${projectId}, 'Failed', 'flow', 'v1.0.0')
  `);
  await db.execute(sql`
    INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
    VALUES (${workspaceId}, ${runId}, ${projectId}, 'maister/x', '/tmp/wt-0179', '/tmp/mig-0179')
  `);

  await applyMainMigration(db, "0179_workbench_git_publication");
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("migration 0179 — publication triple + public branch template", () => {
  it("gives every pre-existing project the default template", async () => {
    const row = await one<{ public_branch_template: string }>(sql`
      SELECT public_branch_template FROM projects WHERE id = ${projectId}
    `);

    expect(row.public_branch_template).toBe("feature/{task_key}-{slug}");
  });

  it("leaves every pre-existing workspace unpublished", async () => {
    const row = await one<{
      published_branch: string | null;
      published_remote: string | null;
      published_at: Date | null;
    }>(sql`
      SELECT published_branch, published_remote, published_at
      FROM workspaces WHERE id = ${workspaceId}
    `);

    expect(row).toEqual({
      published_branch: null,
      published_remote: null,
      published_at: null,
    });
  });

  it("accepts a fully written publication", async () => {
    await db.execute(sql`
      UPDATE workspaces
      SET published_branch = 'feature/MIG0179-1-x', published_remote = 'origin',
          published_at = now()
      WHERE id = ${workspaceId}
    `);

    const row = await one<{ published_branch: string }>(sql`
      SELECT published_branch FROM workspaces WHERE id = ${workspaceId}
    `);

    expect(row.published_branch).toBe("feature/MIG0179-1-x");
  });

  it.each([
    ["a branch without a remote", sql`published_remote = NULL`],
    ["a remote without a timestamp", sql`published_at = NULL`],
    ["a timestamp without a branch", sql`published_branch = NULL`],
  ])("refuses a half-written publication: %s", async (_label, clause) => {
    expect(
      await refusal(
        sql`UPDATE workspaces SET ${clause} WHERE id = ${workspaceId}`,
      ),
    ).toBe("workspaces_published_shape_check");
  });

  it("refuses a NULL template", async () => {
    expect(
      await refusal(sql`
        UPDATE projects SET public_branch_template = NULL WHERE id = ${projectId}
      `),
    ).toMatch(/null value|not-null|public_branch_template/i);
  });
});
