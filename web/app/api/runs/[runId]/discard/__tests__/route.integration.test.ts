// M19 Phase 3 (T3.3 / T3.4): POST /api/runs/[runId]/discard route handler.
// Discard is a single terminal action: requireProjectAction(run.projectId,
// "recoverRun") → markAbandoned (allow-list incl. Crashed) which stamps
// workspaces.scheduled_removal_at in the SAME tx → promoteNextPending → 200
// {ok:true, runStatus:"Abandoned"}. NO synchronous worktree removal
// (workspaces.removed_at stays null; the worktree enters the GC countdown).
//
// markAbandoned + promoteNextPending run against the REAL test DB so the
// scheduled_removal_at stamp and the Pending-promotion are exercised end to
// end; only `@/lib/flows/runner` (the runFlow continuation pulled in by
// promoteNextPending) is mocked to a no-op so the route stays self-contained.
//
//   Crashed run             -> 200 Abandoned + scheduled_removal_at stamped +
//                              oldest Pending promoted + worktree NOT removed
//   already Abandoned       -> 200 idempotent (same-state)
//   RBAC denial             -> 403
//   run not found           -> 404

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;
const {
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
let originalDbUrl: string | undefined;
let projectId: string;
let executorId: string;
let flowId: string;
let flowRevisionId: string;
let originalCap: string | undefined;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// promoteNextPending may dispatch a queued Pending via runFlow; keep it a
// no-op so the route does not pull in the full runner module graph.
const runFlowMock = vi.fn(async () => {});

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...(args as [])),
}));
// A seeded run carries acpSessionId, so a promoted Pending takes the resume
// branch in promoteNextPending — stub driveResume too so the lazy default's
// fire-and-forget dispatch never races this suite's pool teardown.
vi.mock("@/lib/runs/recover", () => ({ driveResume: vi.fn(async () => {}) }));

const MANIFEST = {
  schemaVersion: 1,
  name: "discard",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
    },
  ],
};

let POST: typeof import("@/app/api/runs/[runId]/discard/route").POST;

function request(runId: string): NextRequest {
  return new NextRequest(`http://localhost/api/runs/${runId}/discard`, {
    method: "POST",
  });
}

function invoke(runId: string) {
  return POST(request(runId), { params: Promise.resolve({ runId }) });
}

type SeedRunOpts = {
  status?: string;
  startedAt?: Date;
  withWorkspace?: boolean;
};

async function seedRun(opts: SeedRunOpts = {}): Promise<string> {
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    runKind: "flow",
    status: opts.status ?? "Crashed",
    acpSessionId: "acp-1",
    currentStepId: "implement",
    flowVersion: "v1",
    startedAt: opts.startedAt ?? new Date(),
  });
  if (opts.withWorkspace !== false) {
    await db.insert(workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch: `maister/${runId}`,
      worktreePath: `/worktrees/${runId}`,
      parentRepoPath: "/repos/discard",
    });
  }

  return runId;
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

async function readWorkspace(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, runId));

  return rows[0];
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("discard_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
  originalCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
  flowRevisionId = randomUUID();

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
    slug: "discard-app",
    name: "Discard App",
    repoPath: "/repos/discard",
    maisterYamlPath: "/repos/discard/maister.yaml",
  });
  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "discard",
    source: "github.com/x/discard",
    version: "v1.0.0",
    installedPath: "/tmp/flows/discard",
    manifest: MANIFEST,
    schemaVersion: 1,
  });
  await db.insert(flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "discard",
    source: "github.com/x/discard",
    versionLabel: "v1.0.0",
    resolvedRevision: "deadbeef",
    manifestDigest: "sha256:discard",
    manifest: MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/flows/discard",
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

  ({ POST } = await import("@/app/api/runs/[runId]/discard/route"));
}, 180_000);

afterAll(async () => {
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalCap;
  }
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  runFlowMock.mockClear();
  sessionRef.value = { user: { id: "u-member", role: "member" } };
  await db.delete(workspaces);
  await db.delete(runs);
  await db.delete(tasks);
});

describe("POST /api/runs/[runId]/discard", () => {
  it("Crashed run → 200 Abandoned + scheduled_removal_at stamped + oldest Pending promoted + worktree NOT removed", async () => {
    // Seed a queued Pending so a freed slot promotes it.
    const pending = await seedRun({
      status: "Pending",
      startedAt: new Date(Date.now() - 60_000),
    });
    const crashed = await seedRun({ status: "Crashed" });

    const res = await invoke(crashed);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.runStatus).toBe("Abandoned");

    const crashedRow = await readRun(crashed);

    expect(crashedRow.status).toBe("Abandoned");
    expect(crashedRow.endedAt).not.toBeNull();

    const ws = await readWorkspace(crashed);

    // GC countdown stamped, but NO synchronous removal.
    expect(ws.scheduledRemovalAt).not.toBeNull();
    expect(ws.removedAt).toBeNull();

    // Oldest Pending promoted into the freed slot.
    expect((await readRun(pending)).status).toBe("Running");
  }, 60_000);

  it("already-Abandoned run → 200 idempotent (same-state)", async () => {
    const runId = await seedRun({ status: "Abandoned" });

    const res = await invoke(runId);

    expect(res.status).toBe(200);
    expect((await readRun(runId)).status).toBe("Abandoned");
  }, 60_000);

  it("RBAC denial: a viewer member-role caller → 403", async () => {
    const runId = await seedRun({ status: "Crashed" });

    sessionRef.value = { user: { id: "u-viewer", role: "viewer" } };

    const res = await invoke(runId);

    expect(res.status).toBe(403);
    // Untouched.
    expect((await readRun(runId)).status).toBe("Crashed");
  }, 60_000);

  it("run not found → 404", async () => {
    const res = await invoke("does-not-exist");

    expect(res.status).toBe(404);
  }, 60_000);
});
