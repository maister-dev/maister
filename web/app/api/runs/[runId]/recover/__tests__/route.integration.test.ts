// M19 Phase 3 (T3.2 / T3.4): POST /api/runs/[runId]/recover route handler.
// The route loads the run (server-state), gates on requireProjectAction(
// run.projectId, "recoverRun") against the REAL authz layer + test DB, calls
// resumeCrashedRun(runId), and maps the RecoverResult state → HTTP:
//
//   resumed / redispatched -> 200
//   queued                 -> 202  {state:"queued"}
//   discard-only / conflict-> 409
//   unresumable            -> 410
//   transient              -> 503
//   run not found          -> 404
//   RBAC denial            -> 403
//
// The response DTO must NEVER include acpSessionId (project to {ok, state,
// runStatus?}). resumeCrashedRun itself is unit-tested elsewhere; here it is
// mocked so each state→HTTP edge is asserted in isolation. The auth + project
// membership trust boundary runs against the real DB.

import type { RecoverResult } from "@/lib/runs/recover";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
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

const schema = schemaModule as unknown as Record<string, any>;
const {
  executors,
  flowRevisions,
  flows,
  projectMembers,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;
let flowId: string;
let flowRevisionId: string;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// resumeCrashedRun drives the state→HTTP mapping; mock it per-test.
const resumeCrashedRunMock = vi.fn<(runId: string) => Promise<RecoverResult>>();

vi.mock("@/lib/runs/recover", () => ({
  resumeCrashedRun: (runId: string) => resumeCrashedRunMock(runId),
}));

const MANIFEST = {
  schemaVersion: 1,
  name: "recover",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
    },
  ],
};

let POST: typeof import("@/app/api/runs/[runId]/recover/route").POST;

function request(runId: string): NextRequest {
  return new NextRequest(`http://localhost/api/runs/${runId}/recover`, {
    method: "POST",
  });
}

function invoke(runId: string) {
  return POST(request(runId), { params: Promise.resolve({ runId }) });
}

async function seedRun(): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });
  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId,
    executorId,
    runKind: "flow",
    status: "Crashed",
    acpSessionId: "acp-secret-handle",
    currentStepId: "implement",
    flowVersion: "v1",
    startedAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId}`,
    worktreePath: `/worktrees/${runId}`,
    parentRepoPath: `/repos/recover`,
  });

  return runId;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("recover_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
  flowRevisionId = randomUUID();

  // A member of the project (passes recoverRun=member) and a viewer (fails).
  await db.insert(users).values({
    id: "u-member",
    email: "member@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(users).values({
    id: "u-viewer",
    email: "viewer@test.com",
    role: "viewer",
    accountStatus: "active",
    passwordHash: "x",
  });

  await db.insert(projects).values({
    id: projectId,
    slug: "recover-app",
    name: "Recover App",
    repoPath: "/repos/recover",
    maisterYamlPath: "/repos/recover/maister.yaml",
  });
  await db.insert(executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "recover",
    source: "github.com/x/recover",
    version: "v1.0.0",
    installedPath: "/tmp/flows/recover",
    manifest: MANIFEST,
    schemaVersion: 1,
  });
  await db.insert(flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "recover",
    source: "github.com/x/recover",
    versionLabel: "v1.0.0",
    resolvedRevision: "deadbeef",
    manifestDigest: "sha256:recover",
    manifest: MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/flows/recover",
    packageStatus: "Installed",
  });
  await db.insert(projectMembers).values({
    id: "pm-member",
    projectId,
    userId: "u-member",
    role: "member",
  });
  await db.insert(projectMembers).values({
    id: "pm-viewer",
    projectId,
    userId: "u-viewer",
    role: "viewer",
  });

  ({ POST } = await import("@/app/api/runs/[runId]/recover/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  resumeCrashedRunMock.mockReset();
  sessionRef.value = { user: { id: "u-member", role: "member" } };
});

describe("POST /api/runs/[runId]/recover — state → HTTP mapping", () => {
  it("resumed → 200", async () => {
    const runId = await seedRun();

    resumeCrashedRunMock.mockResolvedValue({ state: "resumed" });

    const res = await invoke(runId);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.state).toBe("resumed");
    expect(body).not.toHaveProperty("acpSessionId");
  }, 60_000);

  it("redispatched → 200", async () => {
    const runId = await seedRun();

    resumeCrashedRunMock.mockResolvedValue({ state: "redispatched" });

    const res = await invoke(runId);

    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("redispatched");
  }, 60_000);

  it("queued → 202 {state:'queued'}", async () => {
    const runId = await seedRun();

    resumeCrashedRunMock.mockResolvedValue({ state: "queued" });

    const res = await invoke(runId);

    expect(res.status).toBe(202);
    expect((await res.json()).state).toBe("queued");
  }, 60_000);

  it("discard-only → 409", async () => {
    const runId = await seedRun();

    resumeCrashedRunMock.mockResolvedValue({ state: "discard-only" });

    const res = await invoke(runId);

    expect(res.status).toBe(409);
  }, 60_000);

  it("conflict → 409", async () => {
    const runId = await seedRun();

    resumeCrashedRunMock.mockResolvedValue({ state: "conflict" });

    const res = await invoke(runId);

    expect(res.status).toBe(409);
  }, 60_000);

  it("unresumable → 410", async () => {
    const runId = await seedRun();

    resumeCrashedRunMock.mockResolvedValue({ state: "unresumable" });

    const res = await invoke(runId);

    expect(res.status).toBe(410);
  }, 60_000);

  it("transient → 503", async () => {
    const runId = await seedRun();

    resumeCrashedRunMock.mockResolvedValue({ state: "transient" });

    const res = await invoke(runId);

    expect(res.status).toBe(503);
  }, 60_000);
});

describe("POST /api/runs/[runId]/recover — boundaries", () => {
  it("run not found → 404 (resumeCrashedRun never called)", async () => {
    const res = await invoke("does-not-exist");

    expect(res.status).toBe(404);
    expect(resumeCrashedRunMock).not.toHaveBeenCalled();
  }, 60_000);

  it("RBAC denial: a viewer member-role caller → 403 (resumeCrashedRun never called)", async () => {
    const runId = await seedRun();

    sessionRef.value = { user: { id: "u-viewer", role: "viewer" } };

    const res = await invoke(runId);

    expect(res.status).toBe(403);
    expect(resumeCrashedRunMock).not.toHaveBeenCalled();
  }, 60_000);

  it("never leaks acpSessionId in the response DTO (any state)", async () => {
    const runId = await seedRun();

    resumeCrashedRunMock.mockResolvedValue({ state: "resumed" });

    const res = await invoke(runId);
    const text = await res.text();

    expect(text).not.toContain("acpSessionId");
    expect(text).not.toContain("acp-secret-handle");
  }, 60_000);
});
