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

// Controllable session. Mocking @/auth also keeps next-auth out of the Vitest
// module graph. The REAL authz layer runs against the test DB, so this exercises
// the actual project-membership trust boundary, not a stub.
const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let POST: typeof import("@/app/api/runs/route").POST;

function request(taskId: string): NextRequest {
  return new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("runs_tb_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Two projects. userU is a member of project A only.
  await db.insert(schema.users).values({
    id: "u-member-a",
    email: "member-a@test.com",
    role: "member",
    passwordHash: "x",
  });
  for (const [id, slug] of [
    ["proj-a", "proj-a"],
    ["proj-b", "proj-b"],
  ] as const) {
    await db.insert(schema.projects).values({
      id,
      slug,
      name: slug,
      repoPath: `/repos/${slug}`,
      maisterYamlPath: `/repos/${slug}/maister.yaml`,
    });
    await db.insert(schema.flows).values({
      id: `flow-${id}`,
      projectId: id,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: `/cache/${id}`,
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    });
  }
  await db.insert(schema.projectMembers).values({
    id: "pm-a",
    projectId: "proj-a",
    userId: "u-member-a",
    role: "member",
  });
  // A Backlog task that belongs to project B (NOT A).
  await db.insert(schema.tasks).values({
    id: "task-in-b",
    projectId: "proj-b",
    title: "B task",
    prompt: "do b",
    flowId: "flow-proj-b",
  });

  ({ POST } = await import("@/app/api/runs/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("POST /api/runs — project-membership trust boundary (integration)", () => {
  it("rejects an anonymous caller with 401", async () => {
    sessionRef.value = null;

    const res = await POST(request("task-in-b"));

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("UNAUTHENTICATED");
  });

  it("rejects launching a task whose project the caller is NOT a member of (403)", async () => {
    // userU is a member of project A; the task lives in project B. The route
    // derives the project from the taskId (server-state) and gates on THAT.
    sessionRef.value = { user: { id: "u-member-a", role: "member" } };

    const res = await POST(request("task-in-b"));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("UNAUTHORIZED");

    // The deny happens before any worktree/run side-effect.
    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-in-b"));

    expect(runs).toHaveLength(0);

    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-in-b"));

    expect(task[0].status).toBe("Backlog");
  });
});
