// M11b Phase 3.0a (RED → GREEN): OpenAPI-derived contract tests for the two
// takeover routes. One assertion per documented status code. Mirrors the
// in-memory db-mock harness of the respond-route test
// (app/api/runs/[runId]/hitl/[hitlRequestId]/respond/__tests__/route.test.ts).
//
// claim: 200 (+ body {worktreePath,branch,ownerUserId}) / 401 / 403 / 404 / 409
// return: 200 / 401 / 403 / 404 / 409 / 503
//
// The git ops, ledger writes, and runner resume are mocked here — these cases
// assert the wire contract (status codes + bodies), not the two-phase
// side-effect mechanics (which the integration suite owns).

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  actorIdentities as actorIdentitiesTable,
  assignmentEvents as assignmentEventsTable,
  assignments as assignmentsTable,
  runs as runsTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

type Row = Record<string, unknown>;

const TAKEOVER_NODE_ID = "review";
const REENTRY_NODE_ID = "checks";

// Minimal compiled-graph manifest with a human_review node that offers the
// `takeover` decision routing to `checks` (the validation re-entry).
const reviewManifest = {
  schemaVersion: 1,
  name: "Fixture",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/impl" },
      transitions: { success: REENTRY_NODE_ID },
    },
    {
      id: REENTRY_NODE_ID,
      type: "check",
      action: { command: "echo ok" },
      transitions: { success: TAKEOVER_NODE_ID },
    },
    {
      id: TAKEOVER_NODE_ID,
      type: "human",
      finish: {
        human: {
          role: "maintainer",
          decisions: ["approve", "rework", "takeover"],
        },
      },
      transitions: {
        approve: "done",
        rework: "implement",
        takeover: REENTRY_NODE_ID,
      },
    },
  ],
};

// --- In-memory loadRun + project + db-mock --------------------------------

const loadedRef: { value: Row | null } = { value: null };
const projectRowRef: { value: Row | null } = { value: null };

function freshLoaded(overrides: Partial<Row> = {}): Row {
  return {
    run: {
      id: "run-1",
      projectId: "proj-1",
      status: "NeedsInput",
      currentStepId: TAKEOVER_NODE_ID,
      flowId: "flow-1",
      ...(overrides.run as Row),
    },
    task: { id: "task-1" },
    flow: { id: "flow-1" },
    manifest: reviewManifest,
    executor: { id: "exec-1", agent: "claude", model: "m" },
    workspace: {
      id: "ws-1",
      runId: "run-1",
      branch: "maister/task-1",
      worktreePath: "/repos/app/.maister/app/runs/run-1/wt",
    },
    projectSlug: "app",
    flowInstallPath: "/cache/flow-1",
    ...overrides,
  };
}

const claimTakeoverSpy = vi.fn(async () => ({ id: "na-1", attempt: 2 }));
const markHumanWorkingSpy = vi.fn(async () => ({ ok: true as const }));
const recordTakeoverReturnSpy = vi.fn(async () => undefined);
const markDownstreamStaleSpy = vi.fn(async () => ({
  staledNodes: 1,
  staledGates: 1,
}));
const markReturnedToRunningSpy = vi.fn(async () => ({ ok: true as const }));
const getActiveTakeoverSpy = vi.fn(async () => ({
  id: "na-1",
  nodeId: TAKEOVER_NODE_ID,
  ownerUserId: "u-test",
  attempt: 2,
  endedAt: null,
}));
const resolveBaseRefSpy = vi.fn(async () => "basesha");
const logRangeSpy = vi.fn(async () => "abc def Commit one\n");
const diffRangeSpy = vi.fn(async () => "diff --git a b\n");
const statusPorcelainSpy = vi.fn(async () => "");
const runFlowSpy = vi.fn(async () => undefined);
const recordArtifactSpy = vi.fn(async () => ({ id: "art-1" }));
const supersedePriorSpy = vi.fn(async () => undefined);
const getCurrentRequiredForGitArtifactsSpy = vi.fn(
  async () => [] as unknown[],
);

// A db whose transaction passes the same fake through. The claim/return
// CAS + selects are exercised through the mocked helpers above, so the db
// itself only needs `.transaction` + a `.update().set().where()` no-op and a
// `.select().from().where().for()` returning the locked run row for the FOR
// UPDATE intent read.
function makeDb(): Row {
  const assignmentRows: Row[] = [];
  const actorRows: Row[] = [];
  const assignmentEventRows: Row[] = [];
  const lockedRun = () => [loadedRef.value!.run as Row];
  const tableOf = (table: unknown) => {
    if (table === runsTable) return "runs";
    if (table === assignmentsTable) return "assignments";
    if (table === actorIdentitiesTable) return "actor_identities";
    if (table === assignmentEventsTable) return "assignment_events";

    return "unknown";
  };
  const rowsFor = (table: unknown) => {
    const name = tableOf(table);

    if (name === "runs") return lockedRun();
    if (name === "assignments") return assignmentRows;
    if (name === "actor_identities") return actorRows;
    if (name === "assignment_events") return assignmentEventRows;

    return lockedRun();
  };
  const insertChain = (table: unknown) => {
    const name = tableOf(table);

    return {
      values: (row: Row) => {
        const inserted = {
          id:
            (row.id as string | undefined) ??
            `${name}-${assignmentRows.length + actorRows.length + 1}`,
          ...row,
        };

        if (name === "assignments") {
          assignmentRows.push(inserted);
        } else if (name === "actor_identities") {
          actorRows.push(inserted);
        } else if (name === "assignment_events") {
          assignmentEventRows.push(inserted);
        }

        const result: any = Promise.resolve(undefined);

        result.onConflictDoUpdate = () => result;
        result.returning = async () => [inserted];

        return result;
      },
    };
  };
  const updateChain = (table: unknown) => ({
    set: (vals: Row) => ({
      where: () => {
        const updated = rowsFor(table).map((row) => {
          Object.assign(row, vals);

          return row;
        });
        const result: any = Promise.resolve(updated);

        result.returning = async () => updated;

        return result;
      },
    }),
  });
  const selectChain = () => ({
    from: (table: unknown) => ({
      where: () => {
        const w = Promise.resolve(rowsFor(table));
        // FOR UPDATE form: .where().for("update")

        return Object.assign(w, { for: async () => rowsFor(table) });
      },
    }),
  });
  const tx = {
    insert: insertChain,
    select: selectChain,
    update: updateChain,
  };

  return {
    insert: insertChain,
    select: selectChain,
    update: updateChain,
    transaction: async (fn: (t: Row) => Promise<unknown>) => fn(tx),
  };
}

vi.mock("@/lib/db/client", () => ({
  getDb: () => makeDb(),
}));

vi.mock("@/lib/flows/graph/runner-core", () => ({
  loadRun: async () => {
    if (!loadedRef.value) {
      throw new MaisterError("PRECONDITION", "run not found: run-1");
    }

    return loadedRef.value;
  },
}));

vi.mock("@/lib/flows/graph/ledger", () => ({
  claimTakeover: (...a: unknown[]) => claimTakeoverSpy(...(a as [])),
  recordTakeoverReturn: (...a: unknown[]) =>
    recordTakeoverReturnSpy(...(a as [])),
  getActiveTakeover: (...a: unknown[]) => getActiveTakeoverSpy(...(a as [])),
  markDownstreamStale: (...a: unknown[]) =>
    markDownstreamStaleSpy(...(a as [])),
}));

vi.mock("@/lib/flows/graph/artifact-store", () => ({
  recordArtifact: (...a: unknown[]) => recordArtifactSpy(...(a as [])),
  supersedePrior: (...a: unknown[]) => supersedePriorSpy(...(a as [])),
  getCurrentRequiredForGitArtifacts: (...a: unknown[]) =>
    getCurrentRequiredForGitArtifactsSpy(...(a as [])),
}));

vi.mock("@/lib/runs/state-transitions", () => ({
  markHumanWorking: (...a: unknown[]) => markHumanWorkingSpy(...(a as [])),
  markReturnedToRunning: (...a: unknown[]) =>
    markReturnedToRunningSpy(...(a as [])),
}));

vi.mock("@/lib/worktree", () => ({
  resolveBaseRef: (...a: unknown[]) => resolveBaseRefSpy(...(a as [])),
  logRange: (...a: unknown[]) => logRangeSpy(...(a as [])),
  diffRange: (...a: unknown[]) => diffRangeSpy(...(a as [])),
  statusPorcelain: (...a: unknown[]) => statusPorcelainSpy(...(a as [])),
}));

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (...a: unknown[]) => runFlowSpy(...(a as [])),
}));

// Project row read (mainBranch) — loaded directly in the return route.
vi.mock("@/lib/runs/takeover-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/runs/takeover-context")>();

  return {
    ...actual,
    loadProjectMainBranch: async () =>
      (projectRowRef.value?.mainBranch as string) ?? "main",
  };
});

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "u-test",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: { id: "u-test", role: "member" },
    role: "member",
  })),
  httpStatusForAuthz: (code: string) =>
    code === "UNAUTHENTICATED"
      ? 401
      : code === "UNAUTHORIZED" || code === "PASSWORD_CHANGE_REQUIRED"
        ? 403
        : null,
}));

beforeEach(() => {
  loadedRef.value = freshLoaded();
  projectRowRef.value = { mainBranch: "main" };
  claimTakeoverSpy.mockReset();
  claimTakeoverSpy.mockResolvedValue({ id: "na-1", attempt: 2 });
  markHumanWorkingSpy.mockReset();
  markHumanWorkingSpy.mockResolvedValue({ ok: true });
  recordTakeoverReturnSpy.mockReset();
  recordTakeoverReturnSpy.mockResolvedValue(undefined);
  markDownstreamStaleSpy.mockReset();
  markDownstreamStaleSpy.mockResolvedValue({ staledNodes: 1, staledGates: 1 });
  recordArtifactSpy.mockReset();
  recordArtifactSpy.mockResolvedValue({ id: "art-1" });
  supersedePriorSpy.mockReset();
  supersedePriorSpy.mockResolvedValue(undefined);
  getCurrentRequiredForGitArtifactsSpy.mockReset();
  getCurrentRequiredForGitArtifactsSpy.mockResolvedValue([]);
  markReturnedToRunningSpy.mockReset();
  markReturnedToRunningSpy.mockResolvedValue({ ok: true });
  getActiveTakeoverSpy.mockReset();
  getActiveTakeoverSpy.mockResolvedValue({
    id: "na-1",
    nodeId: TAKEOVER_NODE_ID,
    ownerUserId: "u-test",
    attempt: 2,
    endedAt: null,
  });
  resolveBaseRefSpy.mockReset();
  resolveBaseRefSpy.mockResolvedValue("basesha");
  logRangeSpy.mockReset();
  logRangeSpy.mockResolvedValue("abc def Commit one\n");
  diffRangeSpy.mockReset();
  diffRangeSpy.mockResolvedValue("diff --git a b\n");
  statusPorcelainSpy.mockReset();
  statusPorcelainSpy.mockResolvedValue("");
  runFlowSpy.mockReset();
  runFlowSpy.mockResolvedValue(undefined);
  vi.mocked(requireActiveSession).mockReset();
  vi.mocked(requireActiveSession).mockResolvedValue({
    id: "u-test",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  } as never);
  vi.mocked(requireProjectAction).mockReset();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: { id: "u-test", role: "member" },
    role: "member",
  } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function invokeClaim(runId = "run-1") {
  const { POST } = await import("../[runId]/takeover/claim/route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/takeover/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
}

async function invokeReturn(runId = "run-1") {
  const { POST } = await import("../[runId]/takeover/return/route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/takeover/return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
}

describe("POST /api/runs/{runId}/takeover/claim — contract", () => {
  it("claim-from-NeedsInput-returns-200-context: 200 + {worktreePath,branch,ownerUserId}", async () => {
    const res = await invokeClaim();

    expect(res.status).toBe(200);
    const body = (await res.json()) as Row;

    expect(body.worktreePath).toBe("/repos/app/.maister/app/runs/run-1/wt");
    expect(body.branch).toBe("maister/task-1");
    expect(body.ownerUserId).toBe("u-test");
  });

  it("401 when unauthenticated", async () => {
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );

    const res = await invokeClaim();

    expect(res.status).toBe(401);
  });

  it("403 when not a project member", async () => {
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires project role: member"),
    );

    const res = await invokeClaim();

    expect(res.status).toBe(403);
  });

  it("claim-run-not-found-404: 404 when the run does not exist", async () => {
    loadedRef.value = null;

    const res = await invokeClaim("ghost");

    expect(res.status).toBe(404);
  });

  it("claim-wrong-state-409: 409 PRECONDITION when run not NeedsInput", async () => {
    loadedRef.value = freshLoaded({
      run: {
        id: "run-1",
        projectId: "proj-1",
        status: "Running",
        currentStepId: TAKEOVER_NODE_ID,
        flowId: "flow-1",
      },
    });

    const res = await invokeClaim();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
  });

  it("concurrent-claim-409: 409 CONFLICT when the CAS is lost", async () => {
    markHumanWorkingSpy.mockResolvedValueOnce({
      ok: false,
      reason: "status-guard-mismatch",
    } as never);

    const res = await invokeClaim();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
  });
});

describe("POST /api/runs/{runId}/takeover/return — contract", () => {
  beforeEach(() => {
    loadedRef.value = freshLoaded({
      run: {
        id: "run-1",
        projectId: "proj-1",
        status: "HumanWorking",
        currentStepId: TAKEOVER_NODE_ID,
        flowId: "flow-1",
      },
    });
  });

  it("return-200: 200 + {ok,runStatus:Running} after side-effects", async () => {
    const res = await invokeReturn();

    expect(res.status).toBe(200);
    const body = (await res.json()) as Row;

    expect(body.ok).toBe(true);
    expect(body.runStatus).toBe("Running");
  });

  it("401 when unauthenticated", async () => {
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );

    const res = await invokeReturn();

    expect(res.status).toBe(401);
  });

  it("non-owner-return-403: 403 when session user != owner_user_id", async () => {
    getActiveTakeoverSpy.mockResolvedValueOnce({
      id: "na-1",
      nodeId: TAKEOVER_NODE_ID,
      ownerUserId: "someone-else",
      attempt: 2,
      endedAt: null,
    });

    const res = await invokeReturn();

    expect(res.status).toBe(403);
  });

  it("return-run-not-found-404: 404 when run does not exist", async () => {
    loadedRef.value = null;

    const res = await invokeReturn("ghost");

    expect(res.status).toBe(404);
  });

  it("return-not-HumanWorking-409: 409 PRECONDITION when not HumanWorking", async () => {
    loadedRef.value = freshLoaded({
      run: {
        id: "run-1",
        projectId: "proj-1",
        status: "Running",
        currentStepId: TAKEOVER_NODE_ID,
        flowId: "flow-1",
      },
    });

    const res = await invokeReturn();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
  });

  it("git-op failure → 409 CONFLICT", async () => {
    diffRangeSpy.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "git diff failed"),
    );

    const res = await invokeReturn();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
  });

  it("ledger-throw-503: 503 EXECUTOR_UNAVAILABLE on a mid-side-effect throw", async () => {
    markDownstreamStaleSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "db down"),
    );

    const res = await invokeReturn();

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EXECUTOR_UNAVAILABLE");
  });
});
