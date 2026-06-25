import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";

const schema = fullSchema as unknown as Record<string, any>;

type Db = NodePgDatabase;

type NullableRow = { is_nullable: "YES" | "NO" };
type DeleteRuleRow = { delete_rule: string };
type IndexRow = { indexname: string };

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_migration_0076_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedProject(slug: string): Promise<string> {
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  return projectId;
}

async function seedUser(emailPrefix: string): Promise<string> {
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `${emailPrefix}-${userId.slice(0, 8)}@example.test`,
    role: "member",
    accountStatus: "active",
  });

  return userId;
}

async function columnNullable(
  tableName: string,
  columnName: string,
): Promise<"YES" | "NO"> {
  const result = await db.execute(sql`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND column_name = ${columnName}
  `);
  const rows = result.rows as NullableRow[];

  expect(rows).toHaveLength(1);

  return rows[0].is_nullable;
}

async function deleteRule(constraintName: string): Promise<string> {
  const result = await db.execute(sql`
    SELECT delete_rule
    FROM information_schema.referential_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name = ${constraintName}
  `);
  const rows = result.rows as DeleteRuleRow[];

  expect(rows).toHaveLength(1);

  return rows[0].delete_rule;
}

async function hasIndex(indexName: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ${indexName}
  `);
  const rows = result.rows as IndexRow[];

  return rows.length === 1;
}

describe("migration 0076 (was 0064) user access token invariants", () => {
  it("makes personal-token and audit project bindings nullable with the designed FK/index shape", async () => {
    const actual = {
      projectTokensProjectNullable: await columnNullable(
        "project_tokens",
        "project_id",
      ),
      tokenAuditProjectNullable: await columnNullable(
        "token_audit_log",
        "project_id",
      ),
      tokenAuditProjectDeleteRule: await deleteRule(
        "token_audit_log_project_id_projects_id_fk",
      ),
      ownerCreatedIndex: await hasIndex("project_tokens_owner_created_idx"),
    };

    expect(actual).toEqual({
      projectTokensProjectNullable: "YES",
      tokenAuditProjectNullable: "YES",
      tokenAuditProjectDeleteRule: "SET NULL",
      ownerCreatedIndex: true,
    });
  });

  it("allows a global personal token row and a global HITL inbox audit row", async () => {
    const ownerUserId = await seedUser("global-token-owner");
    const tokenId = randomUUID();

    await expect(
      db.insert(schema.projectTokens).values({
        id: tokenId,
        project_id: null,
        name: "Personal agent",
        token_kind: "user",
        owner_user_id: ownerUserId,
        prefix: `mai_${randomUUID().slice(0, 8)}`,
        token_hash: randomUUID(),
        scopes: ["hitl:inbox:read"],
      }),
    ).resolves.toBeDefined();

    await expect(
      db.insert(schema.tokenAuditLog).values({
        token_id: tokenId,
        project_id: null,
        actor_label: "token:Personal agent",
        scope_used: "hitl:inbox:read",
        endpoint: "GET /api/v1/ext/hitl",
        method: "GET",
        result: "ok",
        status_code: 200,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects invalid token shapes at the database boundary", async () => {
    const projectId = await seedProject(
      `token-shape-${randomUUID().slice(0, 8)}`,
    );

    await expect(
      db.insert(schema.projectTokens).values({
        id: randomUUID(),
        project_id: projectId,
        name: "Ownerless user token",
        token_kind: "user",
        prefix: `mai_${randomUUID().slice(0, 8)}`,
        token_hash: randomUUID(),
        scopes: ["tasks:read"],
      }),
    ).rejects.toThrow();
  });
});
