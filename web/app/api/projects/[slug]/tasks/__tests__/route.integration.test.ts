import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let POST: typeof import("@/app/api/projects/[slug]/tasks/route").POST;

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/projects/proj-a/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("tasks_tb_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  for (const slug of ["proj-a", "proj-b"]) {
    await db.insert(schema.projects).values({
      id: slug,
      slug,
      name: slug,
      repoPath: `/repos/${slug}`,
      maisterYamlPath: `/repos/${slug}/maister.yaml`,
    });
    await db.insert(schema.flows).values({
      id: `flow-${slug}`,
      projectId: slug,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: `/cache/${slug}`,
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    });
    await db.insert(schema.executors).values({
      id: `exec-${slug}`,
      projectId: slug,
      executorRefId: "claude-sonnet",
      agent: "claude",
      model: "claude-sonnet-4-6",
    });
  }

  // member of proj-a; outsider of neither.
  await db.insert(schema.users).values([
    {
      id: "u-member",
      email: "m@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-outsider",
      email: "o@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-mustchange",
      email: "mc@test.com",
      role: "member",
      passwordHash: "x",
      mustChangePassword: true,
      accountStatus: "active",
    },
  ]);
  await db.insert(schema.projectMembers).values({
    id: "pm-member",
    projectId: "proj-a",
    userId: "u-member",
    role: "member",
  });

  ({ POST } = await import("@/app/api/projects/[slug]/tasks/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("POST /api/projects/[slug]/tasks — trust boundary (integration)", () => {
  it("blocks a forced-password-change caller BEFORE slug probing (403 PASSWORD_CHANGE_REQUIRED)", async () => {
    // Auth-first: a must-change account hitting a NONEXISTENT slug must get the
    // password-change gate (403), NOT a PRECONDITION "project not found" (409)
    // shape-leak. Proves account-state precedes the URL-slug resource read.
    sessionRef.value = { user: { id: "u-mustchange", role: "member" } };

    const res = await POST(
      request({ title: "t", prompt: "p", flowId: "flow-proj-a" }),
      params("does-not-exist"),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("rejects a non-member with 403", async () => {
    sessionRef.value = { user: { id: "u-outsider", role: "member" } };

    const res = await POST(
      request({ title: "t", prompt: "p", flowId: "flow-proj-a" }),
      params("proj-a"),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("UNAUTHORIZED");
  });

  it("rejects a flowId that belongs to a DIFFERENT project (422)", async () => {
    sessionRef.value = { user: { id: "u-member", role: "member" } };

    const res = await POST(
      request({ title: "t", prompt: "p", flowId: "flow-proj-b" }),
      params("proj-a"),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");
  });

  it("rejects an executorOverrideId from a DIFFERENT project (422)", async () => {
    sessionRef.value = { user: { id: "u-member", role: "member" } };

    const res = await POST(
      request({
        title: "t",
        prompt: "p",
        flowId: "flow-proj-a",
        executorOverrideId: "exec-proj-b",
      }),
      params("proj-a"),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");
  });

  it("lets a member create a Backlog task with this project's flow (201)", async () => {
    sessionRef.value = { user: { id: "u-member", role: "member" } };

    const res = await POST(
      request({ title: "Real task", prompt: "do it", flowId: "flow-proj-a" }),
      params("proj-a"),
    );

    expect(res.status).toBe(201);
    const { taskId } = await res.json();

    const rows = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));

    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBe("proj-a");
    expect(rows[0].status).toBe("Backlog");
    expect(rows[0].stage).toBe("Backlog");
  });
});
