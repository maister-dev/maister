import type { ContextSnapshot } from "@/lib/runs/context-snapshot";

import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { NextRequest } from "next/server";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  executionEvents as executionEventsTable,
  runs as runsTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

const dialect = new PgDialect();

type EventSelectRecord = {
  columns: Record<string, unknown>;
  whereSql: string;
  whereParams: unknown[];
};

type DbState = {
  runRow: Record<string, unknown> | null;
  latestSequence: bigint | null;
  eventBatches: Array<Array<Record<string, unknown>>>;
  eventSelects: EventSelectRecord[];
};

const dbState: DbState = {
  runRow: null,
  latestSequence: null,
  eventBatches: [],
  eventSelects: [],
};

const activeControllers: AbortController[] = [];

function createRequest(url: string): NextRequest {
  const controller = new AbortController();

  activeControllers.push(controller);

  return new NextRequest(url, { signal: controller.signal });
}

function createFakeDb() {
  return {
    select: (columns: Record<string, unknown>) => ({
      from: (table: unknown) => {
        let capturedWhere: unknown = null;
        const resolveRows = () => {
          if (table === runsTable) {
            return dbState.runRow ? [dbState.runRow] : [];
          }
          if (table === executionEventsTable) {
            const keys = Object.keys(columns);

            if (keys.length === 1 && keys[0] === "runSequence") {
              return dbState.latestSequence === null
                ? []
                : [{ runSequence: dbState.latestSequence }];
            }

            const compiled =
              capturedWhere && is(capturedWhere, SQL)
                ? dialect.sqlToQuery(capturedWhere)
                : { sql: "", params: [] };

            dbState.eventSelects.push({
              columns,
              whereSql: compiled.sql,
              whereParams: compiled.params,
            });

            return dbState.eventBatches.shift() ?? [];
          }
          throw new Error("unexpected table in fakeDb");
        };

        const chain: Record<string, unknown> = {
          leftJoin: () => chain,
          where: (predicate: unknown) => {
            capturedWhere = predicate;

            return chain;
          },
          orderBy: () => chain,
          limit: () => chain,
          then: (
            onFulfilled: (rows: unknown[]) => unknown,
            onRejected?: (err: unknown) => unknown,
          ) => Promise.resolve(resolveRows()).then(onFulfilled, onRejected),
        };

        return chain;
      },
    }),
  };
}

const fakeDb = createFakeDb();

const requireActiveSessionMock = vi.fn(async () => ({
  id: "user-1",
  role: "member",
  accountStatus: "active",
  mustChangePassword: false,
}));
const requireProjectRoleMock = vi.fn(async () => ({
  user: { id: "user-1" },
  role: "viewer",
}));
const requireProjectRoleForUserMock = vi.fn(async () => ({
  user: { id: "user-1" },
  role: "viewer",
}));
const assertCompanyRunReadAccessMock = vi.fn(async () => undefined);
const assertRunKnowledgeDisclosureMock = vi.fn(async () => undefined);
const assertLocalPackageAssistantActorMock = vi.fn(async () => undefined);
const readContextSnapshotMock =
  vi.fn<
    (
      db: unknown,
      runId: string,
      nodeAttemptId?: string | null,
    ) => Promise<ContextSnapshot>
  >();
const readCurrentAttemptIdMock =
  vi.fn<(db: unknown, runId: string) => Promise<string | null>>();
const contextProjectionThroughMock =
  vi.fn<(db: unknown, runId: string, through: bigint) => Promise<boolean>>();

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: (...args: unknown[]) =>
    requireActiveSessionMock(...(args as [])),
  requireProjectRole: (...args: unknown[]) =>
    requireProjectRoleMock(...(args as [])),
  requireProjectRoleForUser: (...args: unknown[]) =>
    requireProjectRoleForUserMock(...(args as [])),
  httpStatusForAuthz: (code: string) =>
    code === "UNAUTHENTICATED" ? 401 : code === "UNAUTHORIZED" ? 403 : null,
}));

vi.mock("@/lib/agents/company-run-read-access", () => ({
  assertCompanyRunReadAccess: (...args: unknown[]) =>
    assertCompanyRunReadAccessMock(...(args as [])),
}));

vi.mock("@/lib/brain/knowledge-run-disclosure", () => ({
  assertRunKnowledgeDisclosure: (...args: unknown[]) =>
    assertRunKnowledgeDisclosureMock(...(args as [])),
  isRunKnowledgeUnavailable: (error: unknown) =>
    error instanceof MaisterError && error.code === "PRECONDITION",
}));

vi.mock("@/lib/scratch-runs/service", () => ({
  assertLocalPackageAssistantActor: (...args: unknown[]) =>
    assertLocalPackageAssistantActorMock(...(args as [])),
}));

vi.mock("@/lib/runs/context-reader", () => ({
  readContextSnapshot: (
    db: unknown,
    runId: string,
    nodeAttemptId?: string | null,
  ) => readContextSnapshotMock(db, runId, nodeAttemptId),
  readCurrentAttemptId: (db: unknown, runId: string) =>
    readCurrentAttemptIdMock(db, runId),
  contextProjectionThrough: (db: unknown, runId: string, through: bigint) =>
    contextProjectionThroughMock(db, runId, through),
}));

type RouteModule = typeof import("../route");
let route: RouteModule;

beforeAll(async () => {
  route = await import("../route");
});

function makeContextSnapshot(
  runId: string,
  nodeAttemptId: string | null,
  contextSequence: string,
): ContextSnapshot {
  return {
    type: "session.context_snapshot",
    runId,
    runSessionId: "rs-1",
    incarnationId: "inc-1",
    bindingObservedAt: "2026-11-25T12:00:00.000000Z",
    nodeAttemptId,
    lifecycleSequence: "1",
    contextSequence,
    transcriptSequence: contextSequence,
    transcriptRevision: contextSequence,
    usage: {
      used: 1_000,
      size: 100_000,
      sizeSource: "agent_reported",
      observedAt: "2026-11-25T12:00:00.000Z",
      sourceSequence: contextSequence,
    },
    activeCompactions: 0,
    completedCompactions: 0,
    coverage: "from_incarnation_start",
    windowAdvisory: null,
  };
}

function makeEventRow(
  seq: bigint,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: `evt-${seq.toString()}`,
    runSequence: seq,
    eventType: "session.line",
    occurredAt: new Date("2026-11-25T12:00:00.000Z"),
    hostSessionId: "hs-1",
    payloadIsNull: false,
    ...overrides,
  };
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForWakeWaiter(runId: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (runEventWakeBus.waiterCount(runId) > 0) return;
    await flushImmediate();
  }
  throw new Error(`stream did not park on runEventWakeBus for ${runId}`);
}

type SseFrame = {
  id: string | null;
  data: Record<string, unknown>;
};

function parseSseFrames(raw: string): SseFrame[] {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let id: string | null = null;
      let data = "";

      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) id = line.slice(4);
        if (line.startsWith("data: ")) data = line.slice(6);
      }

      return { id, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function closeRunOnNextWake(runId: string): Promise<void> {
  if (dbState.runRow) {
    dbState.runRow = { ...dbState.runRow, status: "Done" };
  }
  vi.advanceTimersByTime(600);
  runEventWakeBus.wake(runId);
  await flushImmediate();
  // Drain an extra wake if the stream parked after setting terminalProjectionCursor
  for (let i = 0; i < 3; i += 1) {
    if (runEventWakeBus.waiterCount(runId) === 0) break;
    vi.advanceTimersByTime(600);
    runEventWakeBus.wake(runId);
    await flushImmediate();
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
  vi.clearAllMocks();

  dbState.runRow = {
    id: "run-default",
    runKind: "flow",
    status: "Running",
    currentStepId: "plan",
    projectId: "proj-1",
    companyId: null,
    createdByUserId: "user-1",
    localPackageId: null,
    isGoverned: false,
  };
  dbState.latestSequence = -1n;
  dbState.eventBatches = [];
  dbState.eventSelects = [];

  requireActiveSessionMock.mockResolvedValue({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  });
  requireProjectRoleMock.mockResolvedValue({
    user: { id: "user-1" },
    role: "viewer",
  });
  requireProjectRoleForUserMock.mockResolvedValue({
    user: { id: "user-1" },
    role: "viewer",
  });
  assertCompanyRunReadAccessMock.mockResolvedValue(undefined);
  assertRunKnowledgeDisclosureMock.mockResolvedValue(undefined);
  assertLocalPackageAssistantActorMock.mockResolvedValue(undefined);
  readCurrentAttemptIdMock.mockResolvedValue("attempt-1");
  readContextSnapshotMock.mockImplementation(
    async (_db, runId, nodeAttemptId = null) =>
      makeContextSnapshot(runId, nodeAttemptId, "1"),
  );
  contextProjectionThroughMock.mockResolvedValue(true);
});

afterEach(async () => {
  while (activeControllers.length > 0) {
    activeControllers.pop()?.abort();
  }
  await flushImmediate();
  vi.useRealTimers();
});

describe("GET /api/runs/[runId]/stream", () => {
  it("projects scalar metadata without executionEvents.payload and uses safe SQL JSONB equality when context=1", async () => {
    const runId = "run-proj-1";

    dbState.runRow = { ...dbState.runRow!, id: runId };
    // Part A: context=false omits payload AND omits contextUsageOnly JSONB expressions
    dbState.eventBatches.push([
      makeEventRow(1n, { eventType: "session.command", payloadIsNull: false }),
    ]);

    const resNoCtx = await route.GET(
      createRequest(`http://localhost/api/runs/${runId}/stream`),
      { params: Promise.resolve({ runId }) },
    );

    expect(resNoCtx.status).toBe(200);
    await waitForWakeWaiter(runId);
    await closeRunOnNextWake(runId);
    const noCtxFrames = parseSseFrames(await resNoCtx.text());

    expect(noCtxFrames).toHaveLength(1);
    expect(noCtxFrames[0].data).not.toHaveProperty("contextUsageOnly");

    const noCtxCols = dbState.eventSelects[0]?.columns;

    expect(noCtxCols).toBeDefined();
    expect(noCtxCols).not.toHaveProperty("payload");
    expect(Object.values(noCtxCols)).not.toContain(
      executionEventsTable.payload,
    );
    expect(noCtxCols).toHaveProperty("payloadIsNull");
    expect(is(noCtxCols.payloadIsNull, SQL)).toBe(true);
    expect(dialect.sqlToQuery(noCtxCols.payloadIsNull as SQL).sql).toMatch(
      /"execution_events"\."payload"\s+IS\s+NULL/i,
    );
    expect(noCtxCols).not.toHaveProperty("contextUsageOnly");

    // Part B: context=1 projects safe JSONB equality without ::boolean casts
    const ctxRunId = "run-proj-2";

    dbState.eventSelects = [];
    dbState.runRow = { ...dbState.runRow!, id: ctxRunId, status: "Running" };
    dbState.eventBatches.push([
      makeEventRow(1n, {
        eventType: "session.line",
        payloadIsNull: false,
        contextUsageOnly: true,
      }),
      // Malformed shapes ("yes", 123, [], null) project as false and must omit contextUsageOnly
      makeEventRow(2n, {
        eventType: "session.line",
        payloadIsNull: false,
        contextUsageOnly: false,
      }),
      makeEventRow(3n, {
        eventType: "session.update",
        payloadIsNull: false,
        contextUsageOnly: false,
      }),
    ]);

    const resCtx = await route.GET(
      createRequest(`http://localhost/api/runs/${ctxRunId}/stream?context=1`),
      { params: Promise.resolve({ runId: ctxRunId }) },
    );

    expect(resCtx.status).toBe(200);
    await waitForWakeWaiter(ctxRunId);
    await closeRunOnNextWake(ctxRunId);
    const ctxFrames = parseSseFrames(await resCtx.text()).filter(
      (f) => f.id !== null,
    );

    expect(ctxFrames).toHaveLength(3);
    expect(ctxFrames[0].data.contextUsageOnly).toBe(true);
    expect(ctxFrames[1].data).not.toHaveProperty("contextUsageOnly");
    expect(ctxFrames[2].data).not.toHaveProperty("contextUsageOnly");

    const ctxCols = dbState.eventSelects[0]?.columns;

    expect(ctxCols).toBeDefined();
    expect(ctxCols).not.toHaveProperty("payload");
    expect(ctxCols).toHaveProperty("payloadIsNull");
    expect(ctxCols).toHaveProperty("contextUsageOnly");
    expect(is(ctxCols.contextUsageOnly, SQL)).toBe(true);

    const ctxSql = dialect.sqlToQuery(ctxCols.contextUsageOnly as SQL).sql;

    expect(ctxSql).toContain("->'contextUsageOnly' = 'true'::jsonb");
    expect(ctxSql).toMatch(/jsonb_typeof\([^)]*->'update'\)\s*=\s*'object'/i);
    expect(ctxSql).not.toMatch(/::\s*bool(ean)?\b/i);
  });

  it("never calls requireProjectRole in the streaming loop and uses requireProjectRoleForUser", async () => {
    const runId = "run-auth-loop";

    dbState.runRow = { ...dbState.runRow!, id: runId };
    dbState.eventBatches.push([makeEventRow(1n)], [makeEventRow(2n)]);

    const res = await route.GET(
      createRequest(`http://localhost/api/runs/${runId}/stream?context=1`),
      { params: Promise.resolve({ runId }) },
    );

    expect(res.status).toBe(200);
    await waitForWakeWaiter(runId);

    // Advance past 2,500 ms periodic auth recheck cadence
    await vi.advanceTimersByTimeAsync(1_000);
    await flushImmediate();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushImmediate();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushImmediate();
    await waitForWakeWaiter(runId);

    await closeRunOnNextWake(runId);
    await res.text();

    expect(requireProjectRoleMock).not.toHaveBeenCalled();
    expect(requireProjectRoleForUserMock).toHaveBeenCalledWith(
      "user-1",
      "proj-1",
      "viewer",
    );
  });

  it("bounds auth rechecks on ordinary project runs while enforcing per-batch and 2,500 ms idle revocation on enrolled and company runs", async () => {
    // 1. Ordinary non-enrolled project run: 10-wake burst within 500 ms + terminal close -> <= 2 auth checks
    const ordinaryRunId = "run-cadence-ord";

    dbState.runRow = {
      ...dbState.runRow!,
      id: ordinaryRunId,
      isGoverned: false,
    };
    for (let i = 1; i <= 10; i += 1) {
      dbState.eventBatches.push([makeEventRow(BigInt(i))]);
    }

    const ordinaryRes = await route.GET(
      createRequest(`http://localhost/api/runs/${ordinaryRunId}/stream`),
      { params: Promise.resolve({ runId: ordinaryRunId }) },
    );

    expect(ordinaryRes.status).toBe(200);
    for (let wake = 1; wake < 10; wake += 1) {
      await waitForWakeWaiter(ordinaryRunId);
      vi.advanceTimersByTime(40);
      runEventWakeBus.wake(ordinaryRunId);
    }
    await waitForWakeWaiter(ordinaryRunId);
    await closeRunOnNextWake(ordinaryRunId);

    const ordinaryFrames = parseSseFrames(await ordinaryRes.text());

    expect(ordinaryFrames).toHaveLength(10);
    expect(requireProjectRoleForUserMock.mock.calls.length).toBeLessThanOrEqual(
      2,
    );
    expect(
      assertRunKnowledgeDisclosureMock.mock.calls.length,
    ).toBeLessThanOrEqual(2);

    // 2. Enrolled project run (isGoverned: true): runs disclosure check before EVERY non-empty batch
    vi.clearAllMocks();
    const enrolledRunId = "run-cadence-enrolled";

    dbState.runRow = {
      id: enrolledRunId,
      runKind: "flow",
      status: "Running",
      currentStepId: "plan",
      projectId: "proj-1",
      companyId: null,
      createdByUserId: "user-1",
      localPackageId: null,
      isGoverned: true,
    };
    dbState.eventBatches = [];
    for (let i = 1; i <= 10; i += 1) {
      dbState.eventBatches.push([makeEventRow(BigInt(i))]);
    }

    const enrolledRes = await route.GET(
      createRequest(`http://localhost/api/runs/${enrolledRunId}/stream`),
      { params: Promise.resolve({ runId: enrolledRunId }) },
    );

    expect(enrolledRes.status).toBe(200);
    for (let wake = 1; wake < 10; wake += 1) {
      await waitForWakeWaiter(enrolledRunId);
      vi.advanceTimersByTime(40);
      runEventWakeBus.wake(enrolledRunId);
    }
    await waitForWakeWaiter(enrolledRunId);
    await closeRunOnNextWake(enrolledRunId);

    const enrolledFrames = parseSseFrames(await enrolledRes.text());

    expect(enrolledFrames).toHaveLength(10);
    // 1 initial GET check + 10 per-non-empty-batch checks = at least 11
    expect(
      assertRunKnowledgeDisclosureMock.mock.calls.length,
    ).toBeGreaterThanOrEqual(11);

    // 3. Company run idle revocation: closes within 2,500 ms even with 0 events arriving
    vi.clearAllMocks();
    const companyRunId = "run-cadence-company";

    dbState.runRow = {
      id: companyRunId,
      runKind: "agent",
      status: "Running",
      currentStepId: null,
      projectId: null,
      companyId: "company-1",
      createdByUserId: "user-1",
      localPackageId: null,
      isGoverned: true,
    };
    dbState.latestSequence = 0n;
    dbState.eventBatches = [];

    const companyRes = await route.GET(
      createRequest(
        `http://localhost/api/runs/${companyRunId}/stream?replay=false`,
      ),
      { params: Promise.resolve({ runId: companyRunId }) },
    );

    expect(companyRes.status).toBe(200);
    const reader = companyRes.body!.getReader();
    const firstChunk = await reader.read();

    expect(new TextDecoder().decode(firstChunk.value)).toContain(
      "session.stream_ready",
    );
    await waitForWakeWaiter(companyRunId);

    assertCompanyRunReadAccessMock.mockRejectedValue(
      new MaisterError("PRECONDITION", "Run is unavailable", {
        details: { reason: "run_unavailable" },
      }),
    );

    const nextRead = reader.read();

    // Advance in bounded steps up to 2,500 ms (no new events!)
    for (let elapsed = 0; elapsed < 2_500; elapsed += 500) {
      await vi.advanceTimersByTimeAsync(500);
      await flushImmediate();
    }

    await expect(nextRead).resolves.toEqual({ done: true, value: undefined });
    expect(
      assertCompanyRunReadAccessMock.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    reader.releaseLock();
  });

  it("coalesces context snapshot reads during a 10-wake burst and parallelizes run snapshot with current attempt lookup", async () => {
    const runId = "run-ctx-burst";

    dbState.runRow = { ...dbState.runRow!, id: runId };
    let runSnapshotPending = false;
    let attemptStartedWhileRunSnapshotPending = false;
    let snapshotSeq = 1;

    readContextSnapshotMock.mockImplementation(
      async (_db, id, nodeAttemptId = null) => {
        if (nodeAttemptId === null) {
          runSnapshotPending = true;
          await Promise.resolve();
          runSnapshotPending = false;
        }

        return makeContextSnapshot(id, nodeAttemptId, String(snapshotSeq));
      },
    );
    readCurrentAttemptIdMock.mockImplementation(async () => {
      if (runSnapshotPending) {
        attemptStartedWhileRunSnapshotPending = true;
      }

      return "attempt-1";
    });

    for (let i = 1; i <= 10; i += 1) {
      dbState.eventBatches.push([makeEventRow(BigInt(i))]);
    }

    const res = await route.GET(
      createRequest(`http://localhost/api/runs/${runId}/stream?context=1`),
      { params: Promise.resolve({ runId }) },
    );

    expect(res.status).toBe(200);

    // Drive a 10-wake burst within 200 ms (20 ms apart)
    for (let wake = 1; wake < 10; wake += 1) {
      await waitForWakeWaiter(runId);
      vi.advanceTimersByTime(20);
      runEventWakeBus.wake(runId);
    }
    await waitForWakeWaiter(runId);

    // During the 200 ms burst: coalesced to <= 2 readContextSnapshot calls (1 run + 1 attempt) instead of 20
    expect(readContextSnapshotMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(attemptStartedWhileRunSnapshotPending).toBe(true);

    // Events stop -> settle read captures updated snapshot
    snapshotSeq = 2;
    vi.advanceTimersByTime(50);
    runEventWakeBus.wake(runId);
    await waitForWakeWaiter(runId);
    const readsAfterSettle = readContextSnapshotMock.mock.calls.length;

    expect(readsAfterSettle).toBeGreaterThan(2);
    expect(readsAfterSettle).toBeLessThanOrEqual(4);

    // Terminal projection watermark -> final snapshot read and clean close
    snapshotSeq = 3;
    await closeRunOnNextWake(runId);
    const raw = await res.text();
    const snapshots = parseSseFrames(raw)
      .filter((f) => f.id === null)
      .map((f) => f.data);

    expect(snapshots.some((s) => s.contextSequence === "2")).toBe(true);
    expect(snapshots.some((s) => s.contextSequence === "3")).toBe(true);
    // Total reads across entire 10-wake burst + settle + terminal watermark stay far below 20
    expect(readContextSnapshotMock.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("skips librarian null-payload events without emitting a frame while advancing the cursor", async () => {
    const runId = "run-lib-1";

    dbState.runRow = {
      id: runId,
      runKind: "librarian",
      status: "Running",
      currentStepId: null,
      projectId: null,
      companyId: null,
      createdByUserId: "user-1",
      localPackageId: null,
      isGoverned: false,
    };
    dbState.eventBatches.push(
      [
        makeEventRow(1n, {
          eventType: "session.line",
          payloadIsNull: true,
        }),
      ],
      [
        makeEventRow(2n, {
          eventType: "session.line",
          payloadIsNull: false,
        }),
      ],
    );

    const res = await route.GET(
      createRequest(`http://localhost/api/runs/${runId}/stream`),
      { params: Promise.resolve({ runId }) },
    );

    expect(res.status).toBe(200);
    await waitForWakeWaiter(runId);

    vi.advanceTimersByTime(50);
    runEventWakeBus.wake(runId);
    await waitForWakeWaiter(runId);

    await closeRunOnNextWake(runId);
    const frames = parseSseFrames(await res.text());

    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe("2");
    expect(frames[0].data.runSequence).toBe("2");

    // Verify cursor advanced to 1n between read 1 and read 2 even though event 1 was skipped
    expect(dbState.eventSelects.length).toBeGreaterThanOrEqual(2);
    expect(dbState.eventSelects[0].whereParams).toContain(-1n);
    expect(dbState.eventSelects[1].whereParams).toContain(1n);
  });
});
