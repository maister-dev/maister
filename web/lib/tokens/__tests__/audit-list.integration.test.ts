import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let ownerUserId: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let listTokenAudit: typeof import("@/lib/tokens/audit-list").listTokenAudit;
let TOKEN_AUDIT_PAGE_SIZE: number;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("token_audit_list_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ownerUserId = randomUUID();
  await db.insert(schema.users).values({
    id: ownerUserId,
    email: `audit-owner-${ownerUserId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });

  const mod = await import("@/lib/tokens/audit-list");

  listTokenAudit = mod.listTokenAudit;
  TOKEN_AUDIT_PAGE_SIZE = mod.TOKEN_AUDIT_PAGE_SIZE;
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

async function seedToken(projectId: string, name: string): Promise<string> {
  const tokenId = randomUUID();

  await db.insert(schema.projectTokens).values({
    id: tokenId,
    project_id: projectId,
    name,
    token_kind: "user",
    owner_user_id: ownerUserId,
    prefix: `mai_${name.slice(0, 4)}`,
    token_hash: randomUUID(),
  });

  return tokenId;
}

async function seedAudit(input: {
  tokenId: string;
  projectId: string;
  actorLabel: string;
  result: "ok" | "error";
  statusCode: number;
  endpoint: string;
  createdAt: Date;
}): Promise<void> {
  await db.insert(schema.tokenAuditLog).values({
    token_id: input.tokenId,
    project_id: input.projectId,
    actor_label: input.actorLabel,
    scope_used: "tasks:create",
    endpoint: input.endpoint,
    method: "POST",
    result: input.result,
    status_code: input.statusCode,
    created_at: input.createdAt,
  });
}

describe("listTokenAudit (M16 audit visibility)", () => {
  let projectA: string;
  let projectB: string;
  let tokenA1: string;
  let tokenA2: string;
  const T0 = new Date("2026-06-18T10:00:00.000Z");
  const T1 = new Date("2026-06-18T10:01:00.000Z");
  const T2 = new Date("2026-06-18T10:02:00.000Z");

  beforeAll(async () => {
    projectA = await seedProject(`audit-a-${randomUUID().slice(0, 8)}`);
    projectB = await seedProject(`audit-b-${randomUUID().slice(0, 8)}`);
    tokenA1 = await seedToken(projectA, "alpha");
    tokenA2 = await seedToken(projectA, "beta");
    const tokenB1 = await seedToken(projectB, "gamma");

    await seedAudit({
      tokenId: tokenA1,
      projectId: projectA,
      actorLabel: "token:alpha",
      result: "ok",
      statusCode: 201,
      endpoint: "/api/v1/ext/projects/a/tasks",
      createdAt: T0,
    });
    await seedAudit({
      tokenId: tokenA2,
      projectId: projectA,
      actorLabel: "token:beta",
      result: "ok",
      statusCode: 200,
      endpoint: "/api/v1/ext/runs/r/readiness",
      createdAt: T1,
    });
    await seedAudit({
      tokenId: tokenA1,
      projectId: projectA,
      actorLabel: "token:alpha",
      result: "error",
      statusCode: 403,
      endpoint: "/api/v1/ext/runs/r/hitl/h/respond",
      createdAt: T2,
    });
    await seedAudit({
      tokenId: tokenB1,
      projectId: projectB,
      actorLabel: "token:gamma",
      result: "ok",
      statusCode: 201,
      endpoint: "/api/v1/ext/projects/b/tasks",
      createdAt: T2,
    });
  });

  it("returns a project's audit rows newest-first with the correct total", async () => {
    const { rows, total, page } = await listTokenAudit(projectA);

    expect(total).toBe(3);
    expect(page).toBe(1);
    expect(rows).toHaveLength(3);
    // newest-first: the T2 error row, then T1, then T0
    expect(rows[0].result).toBe("error");
    expect(rows[0].statusCode).toBe(403);
    expect(rows[0].actorLabel).toBe("token:alpha");
    expect(rows[0].scopeUsed).toBe("tasks:create");
    expect(rows[0].method).toBe("POST");
    expect(rows[2].createdAt.getTime()).toBe(T0.getTime());
  });

  it("never leaks another project's audit rows", async () => {
    const { rows } = await listTokenAudit(projectA);

    expect(
      rows.every((r) => r.tokenId === tokenA1 || r.tokenId === tokenA2),
    ).toBe(true);
    expect(rows.some((r) => r.endpoint.includes("/projects/b/"))).toBe(false);
  });

  it("filters by result", async () => {
    const { rows, total } = await listTokenAudit(projectA, { result: "error" });

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("error");
  });

  it("filters by tokenId", async () => {
    const { rows, total } = await listTokenAudit(projectA, {
      tokenId: tokenA1,
    });

    expect(total).toBe(2);
    expect(rows.every((r) => r.tokenId === tokenA1)).toBe(true);
  });

  it("paginates by offset — a page beyond the data is empty but total stands", async () => {
    const { rows, total, page } = await listTokenAudit(projectA, { page: 2 });

    expect(total).toBe(3);
    expect(page).toBe(2);
    expect(rows).toHaveLength(0);
    expect(TOKEN_AUDIT_PAGE_SIZE).toBeGreaterThan(0);
  });

  it("clamps a non-positive page to 1", async () => {
    const { page } = await listTokenAudit(projectA, { page: 0 });

    expect(page).toBe(1);
  });
});
