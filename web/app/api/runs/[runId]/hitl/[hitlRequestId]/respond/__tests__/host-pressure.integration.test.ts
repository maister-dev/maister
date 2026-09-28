// ADR-183 T4.6 — RED D2: the operator's permission answer meets the host's
// HARD outbox bound. The soft gate admits a resolve command (D1 proves that at
// the host seam); only at hard is an answer refused. The respond route then
// answers 503 EXECUTOR_UNAVAILABLE with the P0-4 reason, the answer stays
// retryable (the refused input's delivery intent is void), and once the host
// prunes below hard the SAME answer, retried, reaches the agent, which then
// finishes its turn. The prune needs the turn to end first: an open prompt's
// v2 span pins every later row, so the keep-alive checkpoint is what frees
// the host here.
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
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { applyHostPressureSample } from "@/lib/scheduler/system-sweeps";
import { resolveHitlErrorMessage } from "@/lib/ui-error-message";
import en from "@/messages/en.json";
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
  unacknowledgedCount: number;
}> {
  const health = (await (
    await fetch(`${sup.url}/health?includeStream=true`)
  ).json()) as {
    stream: { retainedCount: number; unacknowledgedCount: number };
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
    databaseName: "adr183_respond_hard_bound",
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

describe("ADR-183 D2 — an answer under the HARD outbox bound", () => {
  it("is refused retryably with the P0-4 reason, and the same answer delivers once the host prunes below hard", async () => {
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

    // A second, unrelated session whose walletless checkpoints — never
    // refused — fill the outbox while the manager ACKs nothing.
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
    let refused: { status: number; body: Record<string, any> };

    try {
      while ((await hostStream()).retainedCount < HARD_ROWS)
        await transport.checkpointSession(
          filler.sessionId,
          buildEnvelope({
            commandId: randomUUID(),
            kind: "session.checkpoint",
            ...fence,
            payload: {},
          }),
        );

      refused = await respond(seeded.runId, hitl.id);
    } finally {
      held.release();
    }

    // 503, the P0-4 reason, and copy the UI can resolve.
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "event_outbox_backpressure" },
    });
    const message = resolveHitlErrorMessage(refused.body);

    expect(message.key).toBe("errorReasons.event_outbox_backpressure");
    expect(en.run.errorReasons.event_outbox_backpressure).toBeTruthy();
    // The answer is still owed: nothing was delivered.
    const [owed] = (await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitl.id))) as Array<
      Record<string, any>
    >;

    expect(owed.respondedAt).toBeNull();
    const [refusedInput] = await inputsOf(seeded.runId);

    expect(refusedInput).toMatchObject({
      state: "failed",
      lastError: {
        code: "PRECONDITION",
        details: { reason: "event_outbox_backpressure" },
      },
    });

    // The open prompt's v2 span pins every later row, so ACKs alone cannot
    // bring the host below hard while the turn waits on this answer. The
    // keep-alive checkpoint ends the turn — a teardown is never refused —
    // which releases the span; the host then prunes below hard.
    await db
      .update(schema.runs)
      .set({ keepaliveUntil: new Date(0) })
      .where(eq(schema.runs.id, seeded.runId));
    await runSweepTick({
      db: db as never,
      executionHosts: createExecutionHosts({ db }),
    });
    await waitFor(async () => {
      const [run] = (await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, seeded.runId))) as Array<Record<string, any>>;

      return run.status === "NeedsInputIdle";
    }, "the keep-alive park");
    await waitFor(
      async () => (await hostStream()).retainedCount < HARD_ROWS,
      "the host to prune below its hard bound",
    );
    // The refusal also wrote the manager's pressure record, which fences
    // resumes until the sweep's next health sample clears it.
    await waitFor(
      async () =>
        (
          await applyHostPressureSample(
            await createExecutionHosts({ db }).local().platformStatus(),
          )
        )?.transition === "cleared",
      "the sweep's sample to clear the pressure record",
    );
    // The SAME answer, retried, resumes the checkpointed permission and
    // reaches the agent (ADR-180's path) — the refused input left no intent
    // behind to reattach.
    const delivered = await respond(seeded.runId, hitl.id);

    expect([200, 202]).toContain(delivered.status);
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
