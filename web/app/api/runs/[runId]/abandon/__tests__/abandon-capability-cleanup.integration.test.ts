// M14 T4.3 — sub-cycle C2 (RED): the run-abandon route must clean the run's
// per-node capability dirs as it drives the run terminal. This pins the
// OBSERVABLE result of the abandon seam wiring cleanupRunMaterializations:
//   - HTTP 200 { ok:true, runStatus:"Abandoned" } and the run row is Abandoned
//     (existing behavior — reaching terminal already works);
//   - the on-disk per-node capability dir is GONE (the seam ran cleanup);
//   - the node_attempt's materializationPlan.cleanup.status === "done".
//
// Expected RED: the abandon route does NOT yet call any cleanup function, so
// the materialized dir SURVIVES and cleanup.status stays "pending" after a 200.
// (The terminal transition to Abandoned passes; only the capability-dir cleanup
// is missing.)
//
// Harness mirrors abandon.integration.test.ts (auth + db + runFlow mocks) and
// the C1 seed shape (cleanup.integration.test.ts): a real mkdtemp worktree, a
// node_attempts row with a materializationPlan, and a REAL provisioned dir at
// capabilityMaterializationRootPath(worktreePath, runId, nodeAttemptId).

import type { MaterializationPlan } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";

const schema = schemaModule as unknown as Record<string, any>;
const {
  flows,
  nodeAttempts,
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

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// runFlow is invoked by promoteNextPending when a slot frees; mock it inert.
const runFlowSpy = vi.fn(async (_id: string, _opts?: unknown) => undefined);

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (id: string, opts?: unknown) => runFlowSpy(id, opts),
}));

let abandonPOST: typeof import("../route").POST;

let projectId: string;
let ownerId: string;
let executorId: string;
let flowId: string;

// A minimal but VALID MaterializationPlan body (cleanup defaults to pending).
function makePlan(): MaterializationPlan {
  return {
    profileDigest: "digest-c2-abandon",
    resolvedRevisions: [{ refId: "github", kind: "mcp", sha: "sha-abandon" }],
    materializedFiles: ["/tmp/profile.json", "/tmp/.mcp.json"],
    enforcedClasses: ["github"],
    instructedClasses: ["my-skill"],
    refusedClasses: [],
    cleanup: { status: "pending" },
  };
}

type Seeded = {
  runId: string;
  nodeAttemptId: string;
  worktreePath: string;
};

// Seed an ABANDONABLE run (Review) + workspace (real worktree, removedAt:null) +
// one node_attempt carrying a materializationPlan.
async function seedRun(status: string): Promise<Seeded> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-abandon-clean-"));

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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status,
    currentStepId: "implement",
    flowVersion: "v1.0.0",
    startedAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/repos/abandon-clean`,
    removedAt: null,
  });
  await db.insert(nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    materializationPlan: makePlan(),
  });

  return { runId, nodeAttemptId, worktreePath };
}

async function provisionNodeDir(
  worktreePath: string,
  runId: string,
  nodeAttemptId: string,
): Promise<string> {
  const dir = capabilityMaterializationRootPath(
    worktreePath,
    runId,
    nodeAttemptId,
  );

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "profile.json"), "{}");

  return dir;
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

async function reloadPlan(
  nodeAttemptId: string,
): Promise<MaterializationPlan | null> {
  const rows = await db
    .select({ materializationPlan: nodeAttempts.materializationPlan })
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, nodeAttemptId));

  return (rows[0]?.materializationPlan as MaterializationPlan | null) ?? null;
}

function req(runId: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("abandon_cleanup_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  ownerId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();

  await db.insert(users).values({
    id: ownerId,
    email: "owner@maister.local",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(projects).values({
    id: projectId,
    slug: "abandon-clean-app",
    name: "Abandon Clean App",
    repoPath: "/repos/abandon-clean",
    maisterYamlPath: "/repos/abandon-clean/maister.yaml",
  });
  await db.insert(projectMembers).values({
    id: randomUUID(),
    projectId,
    userId: ownerId,
    role: "member",
  });
  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/cache/flow",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  ({ POST: abandonPOST } = await import("../route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(nodeAttempts);
  await db.delete(workspaces);
  await db.delete(runs);
  await db.delete(tasks);
  runFlowSpy.mockReset();
  runFlowSpy.mockResolvedValue(undefined);
  sessionRef.value = { user: { id: ownerId, role: "member" } };
});

describe("POST /api/runs/{runId}/abandon — capability-dir cleanup (C2)", () => {
  it("abandoning a run removes its per-node capability dir and records cleanup.done", async () => {
    const { runId, nodeAttemptId, worktreePath } = await seedRun("Review");
    const dir = await provisionNodeDir(worktreePath, runId, nodeAttemptId);

    expect(await exists(dir)).toBe(true);

    const res = await abandonPOST(req(runId), {
      params: Promise.resolve({ runId }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runStatus: "Abandoned" });

    // Reaching terminal already works (existing behavior).
    const row = (await db.select().from(runs).where(eq(runs.id, runId)))[0];

    expect(row.status).toBe("Abandoned");

    // The capability-dir cleanup is the C2 contract: dir GONE + cleanup.done.
    expect(await exists(dir)).toBe(false);

    const plan = await reloadPlan(nodeAttemptId);

    expect(plan).not.toBeNull();
    expect(plan!.cleanup.status).toBe("done");
    // Plan BODY survives the cleanup transition.
    expect(plan!.profileDigest).toBe("digest-c2-abandon");
    expect(plan!.enforcedClasses).toEqual(["github"]);
  }, 60_000);
});
