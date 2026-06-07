import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  actorIdentities as actorIdentitiesTable,
  assignmentEvents as assignmentEventsTable,
  assignments as assignmentsTable,
  hitlRequests as hitlRequestsTable,
  projects as projectsTable,
  runs as runsTable,
  scratchRuns as scratchRunsTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { respondToHitl, HitlActor } from "@/lib/services/hitl";

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  hitl_requests: Row[];
  projects: Row[];
  scratch_runs: Row[];
  assignments: Row[];
  actor_identities: Row[];
  assignment_events: Row[];
};

const dbState: {
  tables: Tables;
  updates: Array<{ table: string; set: Row }>;
} = {
  tables: {
    runs: [],
    hitl_requests: [],
    projects: [],
    scratch_runs: [],
    assignments: [],
    actor_identities: [],
    assignment_events: [],
  },
  updates: [],
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  if (t === hitlRequestsTable) return "hitl_requests";
  if (t === projectsTable) return "projects";
  if (t === scratchRunsTable) return "scratch_runs";
  if (t === assignmentsTable) return "assignments";
  if (t === actorIdentitiesTable) return "actor_identities";
  if (t === assignmentEventsTable) return "assignment_events";
  throw new Error("unknown table");
}

const selectChain = (cols?: Row) => ({
  from: (table: unknown) => {
    const name = tableOf(table);
    const project = () =>
      cols
        ? dbState.tables[name].map((r) => {
            const o: Row = {};

            for (const k of Object.keys(cols)) o[k] = r[k];

            return o;
          })
        : dbState.tables[name];

    return {
      where: async () => project(),
    };
  },
});

const updateChain = (table: unknown) => {
  const name = tableOf(table);

  return {
    set: (vals: Row) => ({
      where: () => {
        dbState.updates.push({ table: name, set: vals });
        const updated = dbState.tables[name].map((r) => {
          Object.assign(r, vals);

          return r;
        });
        const result: any = Promise.resolve(updated);

        result.returning = async () => updated;

        return result;
      },
    }),
  };
};

const insertChain = (table: unknown) => {
  const name = tableOf(table);
  let inserted: Row | null = null;

  return {
    values: (row: Row) => {
      inserted = { ...row };

      if (name === "actor_identities") {
        const existing = dbState.tables.actor_identities.find(
          (actor) =>
            actor.projectId === row.projectId && actor.userId === row.userId,
        );

        if (existing) {
          Object.assign(existing, row);
          inserted = existing;
        } else {
          dbState.tables.actor_identities.push(inserted);
        }
      } else {
        dbState.tables[name].push(inserted);
      }

      const chain: any = Promise.resolve(undefined);

      chain.onConflictDoUpdate = () => chain;
      chain.returning = async () => (inserted ? [inserted] : []);

      return chain;
    },
  };
};

const fakeDb = {
  insert: insertChain,
  select: (cols?: Row) => selectChain(cols),
  update: updateChain,

  transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    return await fn({
      insert: insertChain,
      select: (cols?: Row) => selectChain(cols),
      update: updateChain,
    });
  },
};

const deliverPermissionSpy = vi.fn(
  async (
    _sessionId: string,
    _requestId: string,
    _optionId: string,
  ): Promise<{ ok: true }> => ({ ok: true }),
);
const cancelPermissionSpy = vi.fn(
  async (
    _sessionId: string,
    _requestId: string,
    _reason: string,
  ): Promise<{ ok: true }> => ({ ok: true }),
);
const runFlowSpy = vi.fn(async (_runId: string): Promise<void> => undefined);
const resumeRunSpy = vi.fn();
const scheduleResumedSessionDriveSpy = vi.fn();

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/supervisor-client", () => ({
  deliverPermission: (sessionId: string, requestId: string, optionId: string) =>
    deliverPermissionSpy(sessionId, requestId, optionId),
  cancelPermission: (sessionId: string, requestId: string, reason: string) =>
    cancelPermissionSpy(sessionId, requestId, reason),
}));

vi.mock("@/lib/flows/runner", () => ({
  runFlow: (runId: string) => runFlowSpy(runId),
}));

vi.mock("@/lib/runs/resume", () => ({
  resumeRun: (...args: unknown[]) => resumeRunSpy(...(args as unknown[])),
}));

vi.mock("@/lib/runs/resume-driver", () => ({
  scheduleResumedSessionDrive: (...args: unknown[]) =>
    scheduleResumedSessionDriveSpy(...(args as unknown[])),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "u-test",
    role: "member",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: { id: "u-test", role: "member" },
    role: "member",
  })),
}));

let runtimeRoot: string;

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "hitl-service-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  dbState.tables = {
    runs: [],
    hitl_requests: [],
    projects: [],
    scratch_runs: [],
    assignments: [],
    actor_identities: [],
    assignment_events: [],
  };
  dbState.updates = [];
  deliverPermissionSpy.mockReset();
  deliverPermissionSpy.mockImplementation(async () => ({ ok: true }));
  cancelPermissionSpy.mockReset();
  cancelPermissionSpy.mockImplementation(async () => ({ ok: true }));
  runFlowSpy.mockReset();
  runFlowSpy.mockImplementation(async () => undefined);
  resumeRunSpy.mockReset();
  scheduleResumedSessionDriveSpy.mockReset();
  scheduleResumedSessionDriveSpy.mockImplementation(() => "drive-id");
});

afterEach(async () => {
  delete process.env.MAISTER_RUNTIME_ROOT;
  await rm(runtimeRoot, { recursive: true, force: true });
});

function seedPermissionRow(
  overrides: Partial<{
    runStatus: string;
    respondedAt: Date | null;
    options: Array<{ optionId: string }>;
    response: Row | null;
    runKind: "flow" | "scratch";
    scratchDialogStatus: string;
  }> = {},
): { runId: string; hitlRequestId: string } {
  const runId = "run-perm";
  const hitlRequestId = "hitl-perm";

  dbState.tables.runs.push({
    id: runId,
    projectId: "proj-1",
    runKind: overrides.runKind ?? "flow",
    status: overrides.runStatus ?? "NeedsInput",
    currentStepId: "plan",
  });
  if (overrides.runKind === "scratch") {
    dbState.tables.scratch_runs.push({
      runId,
      projectId: "proj-1",
      dialogStatus: overrides.scratchDialogStatus ?? "NeedsInput",
      supervisorSessionId: "sup-1",
    });
  }
  dbState.tables.projects.push({ id: "proj-1", slug: "demo" });
  dbState.tables.hitl_requests.push({
    id: hitlRequestId,
    runId,
    stepId: "plan",
    kind: "permission",
    schema: {
      requestId: "req-1",
      supervisorSessionId: "sup-1",
      options: overrides.options ?? [
        { optionId: "allow" },
        { optionId: "deny" },
      ],
    },
    response: overrides.response ?? null,
    respondedAt: overrides.respondedAt ?? null,
  });

  return { runId, hitlRequestId };
}

function seedAssignment(hitlRequestId: string, runId: string): string {
  const assignmentId = `assignment-${hitlRequestId}`;

  dbState.tables.assignments.push({
    id: assignmentId,
    projectId: "proj-1",
    runId,
    taskId: null,
    nodeId: null,
    stepId: "plan",
    hitlRequestId,
    actionKind: "permission",
    status: "open",
    roleRefs: ["security_reviewer"],
    title: "Review permission",
    assigneeActorId: null,
    claimedAt: null,
    completedByActorId: null,
    completedAt: null,
    createdByActorId: null,
  });

  return assignmentId;
}

function seedFormRow(
  kind: "form" | "human" = "form",
  overrides: Partial<{
    runStatus: string;
    respondedAt: Date | null;
    schema: unknown;
    response: unknown;
  }> = {},
): { runId: string; hitlRequestId: string; stepId: string } {
  const runId = "run-form";
  const hitlRequestId = "hitl-form";

  dbState.tables.runs.push({
    id: runId,
    projectId: "proj-1",
    status: overrides.runStatus ?? "NeedsInput",
    currentStepId: "review",
  });
  dbState.tables.projects.push({ id: "proj-1", slug: "demo" });
  dbState.tables.hitl_requests.push({
    id: hitlRequestId,
    runId,
    stepId: "review",
    kind,
    schema: overrides.schema ?? { fields: [] },
    response: overrides.response ?? null,
    respondedAt: overrides.respondedAt ?? null,
  });

  return { runId, hitlRequestId, stepId: "review" };
}

describe("respondToHitl service — kind=permission", () => {
  it("happy two-phase: stores response, delivers, marks respondedAt; returns 200", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    expect(deliverPermissionSpy).toHaveBeenCalledWith(
      "sup-1",
      "req-1",
      "allow",
    );
    const hitl = dbState.tables.hitl_requests[0];

    expect(hitl.response).toEqual({ optionId: "allow" });
    expect(hitl.respondedAt).toBeInstanceOf(Date);
  });

  it("linked assignment is claimed by the responding actor and completed", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const assignmentId = seedAssignment(hitlRequestId, runId);
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    expect(dbState.tables.actor_identities[0]).toMatchObject({
      projectId: "proj-1",
      kind: "user",
      userId: "u-test",
    });
    expect(dbState.tables.assignments[0]).toMatchObject({
      id: assignmentId,
      status: "completed",
      assigneeActorId: dbState.tables.actor_identities[0].id,
      completedByActorId: dbState.tables.actor_identities[0].id,
    });
    expect(
      dbState.tables.assignment_events.map((event) => event.eventKind),
    ).toEqual(["claimed", "responded"]);
  });

  it("rejects optionId not in declared options with CONFIG error", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      options: [{ optionId: "allow" }],
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "rogue" } },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });

  it("HITL_TIMEOUT from supervisor → 410 + runs→Failed + respondedAt set", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("HITL_TIMEOUT", "expired"),
    );

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(410);
    expect(dbState.tables.runs[0].status).toBe("Failed");
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeInstanceOf(Date);
  });

  it("EXECUTOR_UNAVAILABLE from supervisor → 503 + state preserved", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "no supervisor"),
    );

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(503);
    expect(dbState.tables.runs[0].status).toBe("NeedsInput");
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeNull();
    expect(dbState.tables.hitl_requests[0].response).toEqual({
      optionId: "allow",
    });
    // Unreachable supervisor → keep the deferred alive for retry; do NOT cancel.
    expect(cancelPermissionSpy).not.toHaveBeenCalled();
  });

  it("ACP_PROTOCOL from supervisor → releases the live deferred (cancelPermission once) and rethrows", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("ACP_PROTOCOL", "supervisor rejected delivery"),
    );

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "allow" } },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "ACP_PROTOCOL" });

    // The delivery itself failed (deferred still live) → it MUST be released
    // exactly once with the live supervisor handles, or the agent leaks until
    // its keep-alive timeout.
    expect(cancelPermissionSpy).toHaveBeenCalledTimes(1);
    expect(cancelPermissionSpy).toHaveBeenCalledWith(
      "sup-1",
      "req-1",
      expect.stringContaining("ACP_PROTOCOL"),
    );
    // respondedAt stays null (marker was never committed) so a retry can recover.
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeNull();
  });

  it("retry after EXECUTOR_UNAVAILABLE with a DIFFERENT optionId throws CONFLICT", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "no supervisor"),
    );

    const first = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(first.status).toBe(503);
    expect(dbState.tables.hitl_requests[0].response).toEqual({
      optionId: "allow",
    });

    deliverPermissionSpy.mockReset();
    deliverPermissionSpy.mockImplementation(async () => ({ ok: true }));

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "deny" } },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });

  it("retry after EXECUTOR_UNAVAILABLE with the SAME optionId is idempotent and succeeds", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "no supervisor"),
    );

    const first = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(first.status).toBe(503);

    deliverPermissionSpy.mockReset();
    deliverPermissionSpy.mockImplementation(async () => ({ ok: true }));

    const second = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(second.status).toBe(200);
    expect(dbState.tables.hitl_requests[0].response).toEqual({
      optionId: "allow",
    });
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeInstanceOf(Date);
    expect(deliverPermissionSpy).toHaveBeenCalledTimes(1);
  });

  it("already-delivered with the SAME optionId is idempotent and returns 200", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      respondedAt: new Date(),
      response: { optionId: "allow" },
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });

  it("missing optionId throws CONFIG error", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl({ runId, hitlRequestId, body: {} }, actor, { db: fakeDb }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });

  it("run in terminal state (Failed) throws CONFLICT error", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      runStatus: "Failed",
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "allow" } },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });
});

describe("respondToHitl service — kind=form / kind=human", () => {
  it("form happy path: atomicWrite + commit + queueMicrotask runFlow; 200", async () => {
    const { runId, hitlRequestId, stepId } = seedFormRow("form");
    const payload = { approved: true };
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { response: payload } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);

    const artifactPath = join(
      runtimeRoot,
      ".maister",
      "demo",
      "runs",
      runId,
      `input-${stepId}.json`,
    );

    const onDisk = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(onDisk).toEqual(payload);
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeInstanceOf(Date);
    expect(dbState.tables.runs[0].status).toBe("NeedsInput");
    await new Promise((r) => setImmediate(r));
    expect(runFlowSpy).toHaveBeenCalledWith(runId);
  });

  it("human round-trip identical to form except kind is human", async () => {
    const { runId, hitlRequestId, stepId } = seedFormRow("human");
    const payload = { decision: "approve", comments: "lgtm" };
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { response: payload } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    const artifactPath = join(
      runtimeRoot,
      ".maister",
      "demo",
      "runs",
      runId,
      `input-${stepId}.json`,
    );
    const onDisk = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(onDisk).toEqual(payload);
  });

  it("form already-delivered (respondedAt set) with different payload throws CONFLICT", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      respondedAt: new Date(),
      response: { approved: false },
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { response: { approved: true } } },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("form with terminal run state throws CONFLICT error", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      runStatus: "Crashed",
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { response: { approved: true } } },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("missing response body throws CONFIG error", async () => {
    const { runId, hitlRequestId } = seedFormRow("form");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl({ runId, hitlRequestId, body: {} }, actor, { db: fakeDb }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("artifact-write failure returns 503 retryable and does NOT mark respondedAt", async () => {
    const { runId, hitlRequestId } = seedFormRow("form");
    const payload = { approved: true };
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };
    const writeSpy = vi
      .spyOn(await import("@/lib/atomic"), "atomicWriteJson")
      .mockRejectedValueOnce(new Error("EACCES"));

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { response: payload } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(503);
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeNull();
    expect(dbState.tables.hitl_requests[0].response).toEqual(payload);
    writeSpy.mockRestore();
  });
});

describe("respondToHitl service — graph review decision", () => {
  const reviewSchema = {
    review: true,
    allowedDecisions: ["approve", "rework"],
    transitions: { approve: "done", rework: "implement" },
    reworkTargets: ["implement"],
    workspacePolicies: ["keep"],
  };

  it("valid rework decision: 200, persists decision/workspace_policy/rework_target", async () => {
    const { runId, hitlRequestId } = seedFormRow("human", {
      schema: reviewSchema,
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: {
          response: {
            decision: "rework",
            comments: "tighten errors",
            workspacePolicy: "keep",
          },
        },
      },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    const row = dbState.tables.hitl_requests[0];

    expect(row.decision).toBe("rework");
    expect(row.workspacePolicy).toBe("keep");
    expect(row.reworkTarget).toBe("implement");
    expect(row.respondedAt).toBeInstanceOf(Date);
  });

  it("approve decision (terminal target): 200, no rework_target/workspace_policy", async () => {
    const { runId, hitlRequestId } = seedFormRow("human", {
      schema: reviewSchema,
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { response: { decision: "approve" } },
      },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    const row = dbState.tables.hitl_requests[0];

    expect(row.decision).toBe("approve");
    expect(row.reworkTarget).toBeNull();
    expect(row.workspacePolicy).toBeNull();
  });

  it("undeclared decision throws NEEDS_INPUT, no mutation (pre-claim)", async () => {
    const { runId, hitlRequestId } = seedFormRow("human", {
      schema: reviewSchema,
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl(
        {
          runId,
          hitlRequestId,
          body: { response: { decision: "bogus" } },
        },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "NEEDS_INPUT" });
    const row = dbState.tables.hitl_requests[0];

    expect(row.respondedAt).toBeNull();
    expect(row.response).toBeNull();
    expect(row.decision ?? null).toBeNull();
  });
});

describe("respondToHitl service — error cases", () => {
  it("unknown hitlRequestId returns PRECONDITION error", async () => {
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    try {
      await respondToHitl(
        {
          runId: "run-x",
          hitlRequestId: "unknown-hitl",
          body: { optionId: "allow" },
        },
        actor,
        { db: fakeDb },
      );
      expect.fail("should throw");
    } catch (err) {
      if (err instanceof MaisterError) {
        expect(err.code).toBe("PRECONDITION");
        expect(err.message).toContain("hitl request not found");
      } else {
        throw err;
      }
    }
  });

  it("mismatched runId returns PRECONDITION error", async () => {
    seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    try {
      await respondToHitl(
        {
          runId: "other-run",
          hitlRequestId: "hitl-perm",
          body: { optionId: "allow" },
        },
        actor,
        { db: fakeDb },
      );
      expect.fail("should throw");
    } catch (err) {
      if (err instanceof MaisterError) {
        expect(err.code).toBe("PRECONDITION");
      } else {
        throw err;
      }
    }
  });
});

describe("respondToHitl service — actor kind", () => {
  it("user actor (kind=user) processes request normally", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    expect(deliverPermissionSpy).toHaveBeenCalled();
  });

  it("api_token actor answers a permission HITL in its own project (D7 permits permission/form)", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "api_token",
      tokenId: "t1",
      projectId: "proj-1",
      label: "token",
    };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow" } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
  });

  it("api_token actor answering a human-kind HITL throws UNAUTHORIZED (D7)", async () => {
    const { runId, hitlRequestId } = seedFormRow("human");
    const actor: HitlActor = {
      kind: "api_token",
      tokenId: "t1",
      projectId: "proj-1",
      label: "token",
    };

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { response: { approved: true } } },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("api_token actor with a mismatched project throws UNAUTHORIZED", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "api_token",
      tokenId: "t1",
      projectId: "other-project",
      label: "token",
    };

    await expect(
      respondToHitl(
        { runId, hitlRequestId, body: { optionId: "allow" } },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// M17 ADR-054: human_confidence assessment field tests
describe("respondToHitl service — M17 human_confidence", () => {
  it("form response with confidence: 0.8 stores humanConfidence and echoes in response", async () => {
    const { runId, hitlRequestId } = seedFormRow("form");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { response: { userComment: "looks good" }, confidence: 0.8 },
      },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    const stored = dbState.tables.hitl_requests.find(
      (r) => r.id === hitlRequestId,
    );

    expect(stored?.humanConfidence).toBe(0.8);
    expect((stored?.response as any)?.confidence).toBe(0.8);
    expect((stored?.response as any)?.userComment).toBe("looks good");
  });

  it("confidence absent in body leaves humanConfidence NULL", async () => {
    const { runId, hitlRequestId } = seedFormRow("form");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { response: { userComment: "ok" } } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    const stored = dbState.tables.hitl_requests.find(
      (r) => r.id === hitlRequestId,
    );

    expect(stored?.humanConfidence).toBeUndefined();
    expect((stored?.response as any)?.confidence).toBeUndefined();
  });

  it("confidence: 1.5 (out of range) throws NEEDS_INPUT", async () => {
    const { runId, hitlRequestId } = seedFormRow("form");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl(
        {
          runId,
          hitlRequestId,
          body: { response: { field: "value" }, confidence: 1.5 },
        },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "NEEDS_INPUT" });
    const stored = dbState.tables.hitl_requests.find(
      (r) => r.id === hitlRequestId,
    );

    expect(stored?.response).toBeNull();
    // seedFormRow always initialises respondedAt to null; the throw must not have
    // mutated it to a Date, so null (never written to) is correct here.
    expect(stored?.respondedAt).toBeNull();
  });

  it("confidence: -0.1 (out of range) throws NEEDS_INPUT", async () => {
    const { runId, hitlRequestId } = seedFormRow("form");
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl(
        {
          runId,
          hitlRequestId,
          body: { response: { field: "value" }, confidence: -0.1 },
        },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "NEEDS_INPUT" });
  });

  it("permission response ignores confidence in body", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      { runId, hitlRequestId, body: { optionId: "allow", confidence: 0.9 } },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
    const stored = dbState.tables.hitl_requests.find(
      (r) => r.id === hitlRequestId,
    );

    expect(stored?.humanConfidence).toBeUndefined();
    expect((stored?.response as any)?.confidence).toBeUndefined();
    expect((stored?.response as any)?.optionId).toBe("allow");
  });

  it("idempotent retry with same confidence succeeds (200)", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      response: { data: "value", confidence: 0.7 },
      respondedAt: new Date(),
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    const res = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { response: { data: "value" }, confidence: 0.7 },
      },
      actor,
      { db: fakeDb },
    );

    expect(res.status).toBe(200);
  });

  it("conflicting retry with different confidence throws CONFLICT", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      response: { data: "value", confidence: 0.7 },
    });
    const actor: HitlActor = {
      kind: "user",
      userId: "u-test",
      label: "Test User",
    };

    await expect(
      respondToHitl(
        {
          runId,
          hitlRequestId,
          body: { response: { data: "value" }, confidence: 0.9 },
        },
        actor,
        { db: fakeDb },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
