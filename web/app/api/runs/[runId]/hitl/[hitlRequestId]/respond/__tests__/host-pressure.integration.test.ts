// ADR-183 D2: an operator's permission answer remains deliverable while the
// host is soft pressured. Hard refusal is covered at the supervisor boundary.
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { buildEnvelope } from "@/lib/execution-host/ledger";
import { mintPlacement } from "@/lib/execution-host/placement";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import {
  localHost,
  resetResolverForTests,
} from "@/lib/execution-host/resolver";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { runFlow } from "@/lib/flows/runner";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let sup: RealSupervisor;
let proxy: SupervisorFaultProxy;
let projectionWorker: ProjectionWorker;
let restoreUrl: () => void = () => {};
const previousWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const HARD_ROWS = 60;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
  requireActiveSession: vi.fn(async () => ({
    id: "u-1",
    email: "u-1@test.local",
    name: "Test User",
  })),
}));

const FLOW = {
  schemaVersion: 1,
  name: "adr183-d2",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "do thing" },
      transitions: { success: "done" },
    },
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();

    if (value) return value as T;
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for ${what}\nsupervisor log:\n${await sup.logTail(4_000)}`,
      );
    await sleep(100);
  }
}

async function hostStream(): Promise<{
  retainedCount: number;
  pressured: boolean;
  newWorkRefusedBy: string | null;
}> {
  const health = (await (
    await fetch(`${sup.url}/health?includeStream=true`)
  ).json()) as {
    stream: {
      retainedCount: number;
      pressured: boolean;
      newWorkRefusedBy: string | null;
    };
  };

  return health.stream;
}

async function inputsOf(runId: string): Promise<ExecutionCommand[]> {
  return (await db
    .select()
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.runId, runId),
        eq(schema.executionCommands.kind, "session.input"),
      ),
    )
    .orderBy(
      asc(schema.executionCommands.createdAt),
    )) as unknown as ExecutionCommand[];
}

async function respond(
  runId: string,
  hitlRequestId: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const { POST } = await import("../route");
  const response = await POST(
    new NextRequest(
      `http://localhost/api/runs/${runId}/hitl/${hitlRequestId}/respond`,
      { method: "POST", body: JSON.stringify({ optionId: "allow" }) },
    ),
    { params: Promise.resolve({ runId, hitlRequestId }) },
  );

  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "adr183_respond_soft_pressure",
  });
  db = testDatabase.db as unknown as Db;
  const journalDir = await mkdtemp(join(tmpdir(), "adr183-d2-journal-"));

  sup = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      MOCK_ACP_REQUEST_PERMISSION: "1",
      MOCK_ACP_STATE_DIR: journalDir,
      MAISTER_EVENT_OUTBOX_LOW_ROWS: "4",
      MAISTER_EVENT_OUTBOX_SOFT_ROWS: "20",
      MAISTER_EVENT_OUTBOX_HARD_ROWS: String(HARD_ROWS),
    },
  });
  proxy = await startSupervisorFaultProxy(sup.url);
  restoreUrl = useRealSupervisorUrl(proxy.url);
  process.env.MAISTER_WORKTREES_ROOT = join(sup.runtimeRoot, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = join(sup.runtimeRoot, "manager");
  setDefaultTransportForTests(null);
  resetRegistrarStateForTests();
  resetResolverForTests();
  await db.insert(schema.users).values({ id: "u-1", email: "u-1@test.local" });
  projectionWorker = startProjectionWorker({
    db,
    projectors: canonicalProjectors,
  });
}, 180_000);

afterAll(async () => {
  restoreUrl();
  if (previousWorktreesRoot === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousWorktreesRoot;
  if (previousRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = previousRuntimeRoot;
  await stopRuntimeEventConsumers();
  await projectionWorker?.stop();
  await proxy?.close();
  await sup?.kill();
  await testDatabase?.stop();
});

describe("ADR-183 D2 — a permission answer under soft host pressure", () => {
  it("delivers the answer while new work is fenced", async () => {
    const runtimeRoot = process.env.MAISTER_RUNTIME_ROOT as string;
    const repoPath = await initRepo(`${sup.runtimeRoot}/repo-d2`);
    const worktreePath = await addWorktree(
      repoPath,
      `${sup.runtimeRoot}/wt-d2`,
      "maister/d2",
    );
    const seeded = await seedGraphRun(testDatabase.db, FLOW, {
      repoPath,
      workspace: { worktreePath, parentRepoPath: repoPath },
    });
    const placementHost = await localHost({ db });

    await db.transaction((tx) =>
      mintPlacement(tx as unknown as Db, {
        runId: seeded.runId,
        reason: "launch",
        host: placementHost,
      }),
    );
    const flow = runFlow(seeded.runId, {
      db,
      runtimeRoot,
      executionHosts: createExecutionHosts({ db }),
    });
    const hitl = await waitFor(async () => {
      const [row] = (await db
        .select()
        .from(schema.hitlRequests)
        .where(eq(schema.hitlRequests.runId, seeded.runId))) as Array<
        Record<string, any>
      >;
      const [run] = (await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, seeded.runId))) as Array<Record<string, any>>;

      return row && run.status === "NeedsInput" ? row : null;
    }, "the permission park");

    // A second, unrelated session fills the outbox while the manager ACKs
    // nothing. Its checkpoints remain available during soft pressure.
    const transport = createLocalDirectTransport();
    const health = await transport.health();

    if (health.kind !== "ready" || health.identity === null)
      throw new Error("host not ready");
    const fence = {
      hostKey: health.identity.hostKey,
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
      runId: randomUUID(),
    };
    const workspace = join(sup.runtimeRoot, "d2-filler");

    await mkdir(workspace, { recursive: true });
    const adopted = await transport.adoptWorkspace(
      buildEnvelope({
        commandId: randomUUID(),
        kind: "workspace.adopt",
        ...fence,
        payload: {
          runId: fence.runId,
          projectSlug: "d2-filler",
          kind: "directory",
          path: workspace,
        },
      }),
    );
    const filler = await transport.createSession(
      buildEnvelope({
        commandId: randomUUID(),
        kind: "session.create",
        ...fence,
        payload: {
          executionWorkspaceId: adopted.executionWorkspaceId,
          stepId: "filler",
          executor: { agent: "claude", model: "mock" },
        },
      }),
    );
    const held = proxy.arm(
      { caseId: "adr183-d2-behind", method: "GET", path: /^\/runtime-events$/ },
      "hold-events",
    );
    let delivered: { status: number; body: Record<string, any> };

    try {
      while (!(await hostStream()).pressured)
        await transport.checkpointSession(
          filler.sessionId,
          buildEnvelope({
            commandId: randomUUID(),
            kind: "session.checkpoint",
            ...fence,
            payload: {},
          }),
        );

      const stream = await hostStream();

      expect(stream.retainedCount).toBeLessThan(HARD_ROWS);
      expect(stream.newWorkRefusedBy).toBe("unacknowledged");
      delivered = await respond(seeded.runId, hitl.id);
    } finally {
      held.release();
    }

    expect([200, 202]).toContain(delivered.status);
    const [answered] = (await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitl.id))) as Array<
      Record<string, any>
    >;

    expect(answered.respondedAt).not.toBeNull();
    expect((await inputsOf(seeded.runId))[0]).toMatchObject({
      state: "succeeded",
    });
    await waitFor(async () => {
      const [run] = (await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, seeded.runId))) as Array<Record<string, any>>;

      return run.status === "Review";
    }, "the agent to finish its turn");
    await flow.catch(() => undefined);
  }, 180_000);
});
