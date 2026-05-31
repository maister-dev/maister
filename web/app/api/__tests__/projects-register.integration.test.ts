import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// installFlowPlugin behavior is swapped per test.
const installFlowPlugin = vi.fn(async () => undefined);

// The seeded bootstrap admin (migration 0005) is the FK target for the owner
// membership; requireGlobalRole is mocked to return it (avoids @/auth →
// next-auth in the Vitest module graph).
const ADMIN_ID = "usr_bootstrap_admin";

const seedConfig = {
  schemaVersion: 2,
  project: {
    name: "Saga Proj",
    repo_path: "/repos/saga-proj",
    main_branch: "main",
    branch_prefix: "maister/",
  },
  executors: [
    { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-6" },
  ],
  default_executor: "claude-sonnet",
  flows: [{ id: "bugfix", source: "github.com/x/y", version: "v1.0.0" }],
  capabilities: {
    mcps: [],
    skills: [],
    rules: [],
    restrictions: [],
    settings: [],
    tools: [],
  },
};

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: vi.fn(async () => ({
    id: ADMIN_ID,
    role: "admin",
    mustChangePassword: false,
  })),
}));

vi.mock("@/lib/config", () => ({
  loadPlatformMcpCapabilities: vi.fn(async () => []),
  loadProjectConfig: vi.fn(async () => seedConfig),
}));

vi.mock("@/lib/flows", () => ({
  installFlowPlugin: (...args: unknown[]) => installFlowPlugin(...(args as [])),
}));

// This saga test is about flow-install rollback, not source resolution; mock
// resolveProjectSource so no real git clone/init runs. clonedByUs:false means
// the route's clone-cleanup path never fires.
vi.mock("@/lib/repo-source", () => ({
  resolveProjectSource: vi.fn(async () => ({
    dir: "/repos/saga-proj",
    repoUrl: null,
    provider: null,
    gitStatus: "no-remote",
    clonedByUs: false,
  })),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

let POST: typeof import("@/app/api/projects/route").POST;

function request(): NextRequest {
  return new NextRequest("http://localhost/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "saga-proj" }),
  });
}

async function projectRows(slug: string) {
  return db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.slug, slug));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("projects_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ POST } = await import("@/app/api/projects/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  installFlowPlugin.mockReset();
});

describe("POST /api/projects — flow-install failure saga (integration)", () => {
  it("rolls the whole project back when a flow install fails, leaving no row", async () => {
    installFlowPlugin.mockRejectedValueOnce(
      new MaisterError("FLOW_INSTALL", "clone failed"),
    );

    const res = await POST(request());

    expect(res.status).toBe(502);
    const body = await res.json();

    expect(body.code).toBe("FLOW_INSTALL");

    // Full compensation: project + cascade children are gone.
    expect(await projectRows("saga-proj")).toHaveLength(0);

    const execs = await db
      .select()
      .from(schema.executors)
      .where(eq(schema.executors.executorRefId, "claude-sonnet"));

    expect(execs).toHaveLength(0);
  });

  it("allows an identical retry to succeed (no leftover 409)", async () => {
    installFlowPlugin.mockResolvedValue(undefined);

    const res = await POST(request());

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.slug).toBe("saga-proj");

    const rows = await projectRows("saga-proj");

    expect(rows).toHaveLength(1);

    const members = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.projectId, rows[0].id));

    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("owner");
  });
});
