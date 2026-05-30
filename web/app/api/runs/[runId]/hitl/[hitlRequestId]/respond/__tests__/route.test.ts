import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession } from "@/lib/authz";
import {
  hitlRequests as hitlRequestsTable,
  projects as projectsTable,
  runs as runsTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  hitl_requests: Row[];
  projects: Row[];
};

const dbState: {
  tables: Tables;
  updates: Array<{ table: string; set: Row }>;
} = {
  tables: { runs: [], hitl_requests: [], projects: [] },
  updates: [],
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  if (t === hitlRequestsTable) return "hitl_requests";
  if (t === projectsTable) return "projects";
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
      where: async () => {
        dbState.updates.push({ table: name, set: vals });
        for (const r of dbState.tables[name]) Object.assign(r, vals);
      },
    }),
  };
};

const fakeDb = {
  select: (cols?: Row) => selectChain(cols),
  update: updateChain,

  transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    return await fn({
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
const runFlowSpy = vi.fn(async (_runId: string): Promise<void> => undefined);

// [FIX] M8 review finding #2 / #3: mocks for the idle-branch
// dependencies. Tests override these per-case.
const resumeRunSpy = vi.fn();
const scheduleResumedSessionDriveSpy = vi.fn();

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/supervisor-client", () => ({
  deliverPermission: (sessionId: string, requestId: string, optionId: string) =>
    deliverPermissionSpy(sessionId, requestId, optionId),
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

// Stub the authz boundary so the route's RBAC check passes without pulling
// in @/auth → next-auth (whose beta ESM trips the Vitest resolver). These
// cases exercise the two-phase/error logic, not authorization.
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
  runtimeRoot = await mkdtemp(join(tmpdir(), "hitl-resp-"));
  process.env.MAISTER_RUNTIME_ROOT = runtimeRoot;
  dbState.tables = { runs: [], hitl_requests: [], projects: [] };
  dbState.updates = [];
  deliverPermissionSpy.mockReset();
  deliverPermissionSpy.mockImplementation(async () => ({ ok: true }));
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
  }> = {},
): { runId: string; hitlRequestId: string } {
  const runId = "run-perm";
  const hitlRequestId = "hitl-perm";

  dbState.tables.runs.push({
    id: runId,
    projectId: "proj-1",
    status: overrides.runStatus ?? "NeedsInput",
    currentStepId: "plan",
  });
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

async function invokePost(runId: string, hitlRequestId: string, body: unknown) {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(
      `http://localhost/api/runs/${runId}/hitl/${hitlRequestId}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );

  return POST(req, {
    params: Promise.resolve({ runId, hitlRequestId }),
  });
}

describe("HITL respond route — kind=permission", () => {
  it("happy two-phase: stores response, delivers, marks respondedAt; returns 200", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

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

  it("rejects optionId not in declared options with 400", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      options: [{ optionId: "allow" }],
    });

    const res = await invokePost(runId, hitlRequestId, {
      optionId: "rogue",
    });

    expect(res.status).toBe(400);
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });

  it("HITL_TIMEOUT from supervisor → 410 + runs→Failed + respondedAt set", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("HITL_TIMEOUT", "expired"),
    );

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(410);
    expect(dbState.tables.runs[0].status).toBe("Failed");
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeInstanceOf(Date);
  });

  it("EXECUTOR_UNAVAILABLE from supervisor → 503 + state preserved", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "no supervisor"),
    );

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(503);
    expect(dbState.tables.runs[0].status).toBe("NeedsInput");
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeNull();
    expect(dbState.tables.hitl_requests[0].response).toEqual({
      optionId: "allow",
    });
  });

  it("retry after EXECUTOR_UNAVAILABLE with a DIFFERENT optionId returns 409 (atomic claim contract)", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "no supervisor"),
    );

    const first = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(first.status).toBe(503);
    // First call claimed the row with `allow`. A second submission must
    // not silently overwrite the user's prior choice.
    expect(dbState.tables.hitl_requests[0].response).toEqual({
      optionId: "allow",
    });

    const second = await invokePost(runId, hitlRequestId, {
      optionId: "deny",
    });

    expect(second.status).toBe(409);
    expect(deliverPermissionSpy).toHaveBeenCalledTimes(1);
  });

  it("retry after EXECUTOR_UNAVAILABLE with the SAME optionId is idempotent and succeeds", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "no supervisor"),
    );

    const first = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(first.status).toBe(503);

    const second = await invokePost(runId, hitlRequestId, {
      optionId: "allow",
    });

    expect(second.status).toBe(200);
    expect(dbState.tables.hitl_requests[0].response).toEqual({
      optionId: "allow",
    });
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeInstanceOf(Date);
    expect(deliverPermissionSpy).toHaveBeenCalledTimes(2);
  });

  it("already-delivered (respondedAt set) → 409", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      respondedAt: new Date(),
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(409);
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });

  it("already-delivered with the SAME optionId is idempotent and returns 200", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      respondedAt: new Date(),
      response: { optionId: "allow" },
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(200);
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });

  it("HITL_TIMEOUT from supervisor when respondedAt is already set by a concurrent winner returns 200 (no run→Failed)", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();

    deliverPermissionSpy.mockImplementation(async () => {
      dbState.tables.hitl_requests[0].respondedAt = new Date();
      throw new MaisterError("HITL_TIMEOUT", "expired");
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(200);
    expect(dbState.tables.runs[0].status).toBe("NeedsInput");
  });

  it("run in terminal state (Failed) → 409", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      runStatus: "Failed",
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(409);
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });

  it("missing optionId returns 400 CONFIG", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();

    const res = await invokePost(runId, hitlRequestId, {});

    expect(res.status).toBe(400);
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
  });
});

describe("HITL respond route — kind=form / kind=human", () => {
  it("form happy path: atomicWrite + commit + queueMicrotask runFlow; 200", async () => {
    const { runId, hitlRequestId, stepId } = seedFormRow("form");
    const payload = { approved: true };

    const res = await invokePost(runId, hitlRequestId, { response: payload });

    expect(res.status).toBe(200);

    const artifactPath = join(
      runtimeRoot,
      ".maister",
      "demo",
      "runs",
      runId,
      `input-${stepId}.json`,
    );

    expect(existsSync(artifactPath)).toBe(true);
    const onDisk = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(onDisk).toEqual(payload);
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeInstanceOf(Date);
    // runs.status stays NeedsInput so runFlow's resume path fires
    // instead of restarting the flow at step 0. The runner is the one
    // that performs the NeedsInput → Running transition.
    expect(dbState.tables.runs[0].status).toBe("NeedsInput");
    await new Promise((r) => setImmediate(r));
    expect(runFlowSpy).toHaveBeenCalledWith(runId);
  });

  it("human round-trip identical to form except kind is human", async () => {
    const { runId, hitlRequestId, stepId } = seedFormRow("human");
    const payload = { decision: "approve", comments: "lgtm" };

    const res = await invokePost(runId, hitlRequestId, { response: payload });

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

  it("form already-delivered (respondedAt set) → 409", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      respondedAt: new Date(),
    });

    const res = await invokePost(runId, hitlRequestId, {
      response: { approved: true },
    });

    expect(res.status).toBe(409);
  });

  it("form with terminal run state → 409", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      runStatus: "Crashed",
    });

    const res = await invokePost(runId, hitlRequestId, {
      response: { approved: true },
    });

    expect(res.status).toBe(409);
  });

  it("missing response body returns 400 CONFIG", async () => {
    const { runId, hitlRequestId } = seedFormRow("form");
    const res = await invokePost(runId, hitlRequestId, {});

    expect(res.status).toBe(400);
  });

  it("schema validation: scalar response when fields are declared returns 422", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      schema: {
        fields: [{ name: "approved", type: "boolean", required: true }],
      },
    });
    const res = await invokePost(runId, hitlRequestId, {
      response: "yes",
    });

    expect(res.status).toBe(422);
  });

  it("schema validation: missing required field returns 422 and does NOT write the artifact", async () => {
    const { runId, hitlRequestId, stepId } = seedFormRow("form", {
      schema: {
        fields: [{ name: "approved", type: "boolean", required: true }],
      },
    });
    const res = await invokePost(runId, hitlRequestId, {
      response: { comments: "no opinion" },
    });

    expect(res.status).toBe(422);
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeNull();
    const artifactPath = join(
      runtimeRoot,
      ".maister",
      "demo",
      "runs",
      runId,
      `input-${stepId}.json`,
    );

    expect(existsSync(artifactPath)).toBe(false);
  });

  it("schema validation: enum value outside options returns 422", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      schema: {
        fields: [
          {
            name: "decision",
            type: "enum",
            required: true,
            options: ["approve", "reject"],
          },
        ],
      },
    });
    const res = await invokePost(runId, hitlRequestId, {
      response: { decision: "maybe" },
    });

    expect(res.status).toBe(422);
  });

  it("schema validation: typed payload that matches the schema is accepted", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      schema: {
        fields: [
          { name: "approved", type: "boolean", required: true },
          { name: "comments", type: "string" },
        ],
      },
    });
    const res = await invokePost(runId, hitlRequestId, {
      response: { approved: true, comments: "lgtm" },
    });

    expect(res.status).toBe(200);
    expect(dbState.tables.hitl_requests[0].response).toEqual({
      approved: true,
      comments: "lgtm",
    });
  });

  it("concurrent same-payload double-submit is idempotent and returns 200 both times", async () => {
    const { runId, hitlRequestId } = seedFormRow("form");
    const payload = { approved: true };
    const first = await invokePost(runId, hitlRequestId, { response: payload });

    expect(first.status).toBe(200);

    const second = await invokePost(runId, hitlRequestId, {
      response: payload,
    });

    expect(second.status).toBe(200);
    expect(dbState.tables.hitl_requests[0].response).toEqual(payload);
  });

  it("concurrent DIFFERENT-payload double-submit: second returns 409 and does NOT overwrite the artifact", async () => {
    const { runId, hitlRequestId, stepId } = seedFormRow("form");
    const first = await invokePost(runId, hitlRequestId, {
      response: { approved: true },
    });

    expect(first.status).toBe(200);

    const artifactPath = join(
      runtimeRoot,
      ".maister",
      "demo",
      "runs",
      runId,
      `input-${stepId}.json`,
    );
    const before = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(before).toEqual({ approved: true });

    const second = await invokePost(runId, hitlRequestId, {
      response: { approved: false },
    });

    expect(second.status).toBe(409);
    const after = JSON.parse(await readFile(artifactPath, "utf8"));

    expect(after).toEqual({ approved: true });
  });

  it("same-payload retry on an already-delivered row re-queues runFlow when the run is still NeedsInput", async () => {
    // Simulate a process restart between Phase 3 commit and the
    // queueMicrotask wake. We seed the row as already-delivered
    // with respondedAt set, response stored, runStatus=NeedsInput.
    // A second submission with the same payload should re-fire
    // runFlow even though the route already considers the request
    // delivered.
    const { runId, hitlRequestId } = seedFormRow("form", {
      respondedAt: new Date(),
      response: { approved: true },
    });
    const res = await invokePost(runId, hitlRequestId, {
      response: { approved: true },
    });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(runFlowSpy).toHaveBeenCalledWith(runId);
  });

  it("same-payload retry does NOT re-queue runFlow if the run has already advanced past NeedsInput", async () => {
    const { runId, hitlRequestId } = seedFormRow("form", {
      respondedAt: new Date(),
      response: { approved: true },
      runStatus: "Running",
    });
    const res = await invokePost(runId, hitlRequestId, {
      response: { approved: true },
    });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(runFlowSpy).not.toHaveBeenCalled();
  });

  it("artifact-write failure returns 503 retryable and does NOT mark respondedAt", async () => {
    const { runId, hitlRequestId } = seedFormRow("form");
    const payload = { approved: true };
    const writeSpy = vi
      .spyOn(await import("@/lib/atomic"), "atomicWriteJson")
      .mockRejectedValueOnce(new Error("EACCES"));
    const res = await invokePost(runId, hitlRequestId, { response: payload });

    expect(res.status).toBe(503);
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeNull();
    // Response IS stored — the user's intent is captured durably
    // so a retry replays the same value.
    expect(dbState.tables.hitl_requests[0].response).toEqual(payload);
    writeSpy.mockRestore();
  });
});

describe("HITL respond route — graph review decision (M11a)", () => {
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

    const res = await invokePost(runId, hitlRequestId, {
      response: {
        decision: "rework",
        comments: "tighten errors",
        workspacePolicy: "keep",
      },
    });

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

    const res = await invokePost(runId, hitlRequestId, {
      response: { decision: "approve" },
    });

    expect(res.status).toBe(200);
    const row = dbState.tables.hitl_requests[0];

    expect(row.decision).toBe("approve");
    expect(row.reworkTarget).toBeNull();
    expect(row.workspacePolicy).toBeNull();
  });

  it("undeclared decision → 422 NEEDS_INPUT, no mutation (pre-claim)", async () => {
    const { runId, hitlRequestId } = seedFormRow("human", {
      schema: reviewSchema,
    });

    const res = await invokePost(runId, hitlRequestId, {
      response: { decision: "bogus" },
    });

    expect(res.status).toBe(422);
    const row = dbState.tables.hitl_requests[0];

    expect(row.respondedAt).toBeNull();
    expect(row.response).toBeNull();
    expect(row.decision ?? null).toBeNull();
  });

  it("rework with an unallowed workspacePolicy → 422, no mutation", async () => {
    const { runId, hitlRequestId } = seedFormRow("human", {
      schema: reviewSchema,
    });

    const res = await invokePost(runId, hitlRequestId, {
      response: { decision: "rework", workspacePolicy: "fresh-attempt" },
    });

    expect(res.status).toBe(422);
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeNull();
  });
});

describe("HITL respond route — error cases", () => {
  it("unknown hitlRequestId (empty table) returns 409 PRECONDITION", async () => {
    const res = await invokePost("run-x", "unknown-hitl", {
      optionId: "allow",
    });

    expect(res.status).toBe(409);
  });

  it("mismatched runId returns 409 PRECONDITION", async () => {
    seedPermissionRow();
    const res = await invokePost("other-run", "hitl-perm", {
      optionId: "allow",
    });

    expect(res.status).toBe(409);
  });

  it("malformed JSON body returns 400 CONFIG", async () => {
    const { POST } = await import("../route");
    const { runId, hitlRequestId } = seedPermissionRow();
    const req = new NextRequest(
      new Request(
        `http://localhost/api/runs/${runId}/hitl/${hitlRequestId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not valid",
        },
      ),
    );

    const res = await POST(req, {
      params: Promise.resolve({ runId, hitlRequestId }),
    });

    expect(res.status).toBe(400);
  });
});

describe("HITL respond route — [FIX] NeedsInputIdle branch", () => {
  it("schedules the driver and returns 202 on resumeRun success", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      runStatus: "NeedsInputIdle",
    });

    resumeRunSpy.mockResolvedValueOnce({
      ok: true,
      newSupervisorSessionId: "sup-2",
      acpSessionId: "acp-1",
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { state?: string };

    expect(body.state).toBe("resume-in-progress");
    expect(resumeRunSpy).toHaveBeenCalledTimes(1);
    expect(scheduleResumedSessionDriveSpy).toHaveBeenCalledTimes(1);
    expect(scheduleResumedSessionDriveSpy.mock.calls[0]?.[0]).toMatchObject({
      runId,
      supervisorSessionId: "sup-2",
      acpSessionId: "acp-1",
      stepId: "plan",
    });
  });

  it("CLAIM_RACE → 202 resume-in-progress (NOT 410); driver NOT scheduled", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      runStatus: "NeedsInputIdle",
    });

    resumeRunSpy.mockResolvedValueOnce({
      ok: false,
      code: "CLAIM_RACE",
      retryable: false,
      message: "concurrent resume in progress",
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(202);
    expect(scheduleResumedSessionDriveSpy).not.toHaveBeenCalled();
  });

  it("retryable EXECUTOR_UNAVAILABLE → 503 with terminal:false", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      runStatus: "NeedsInputIdle",
    });

    resumeRunSpy.mockResolvedValueOnce({
      ok: false,
      code: "EXECUTOR_UNAVAILABLE",
      retryable: true,
      message: "supervisor 503",
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { terminal?: boolean };

    expect(body.terminal).toBe(false);
    expect(scheduleResumedSessionDriveSpy).not.toHaveBeenCalled();
  });

  it("terminal CHECKPOINT → 410 with terminal:true", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      runStatus: "NeedsInputIdle",
    });

    resumeRunSpy.mockResolvedValueOnce({
      ok: false,
      code: "CHECKPOINT",
      retryable: false,
      message: "supervisor 400",
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(410);
    const body = (await res.json()) as { terminal?: boolean };

    expect(body.terminal).toBe(true);
    expect(scheduleResumedSessionDriveSpy).not.toHaveBeenCalled();
  });

  it("[FIX-PASS2-F1] same-payload retry after resume started: noop-idempotent + NeedsInput + supervisor 404 → 202 (NOT Failed)", async () => {
    // Scenario: original /respond was for NeedsInputIdle; resumeRun
    // moved status to NeedsInput; driver is delivering against a fresh
    // requestId. Operator retries with the same payload. The route
    // sees noop-idempotent + NeedsInput, calls deliverPermission with
    // the STALE supervisorSessionId/requestId from the original
    // checkpointed session, supervisor returns 404 HITL_TIMEOUT. The
    // route MUST recognize this as a likely in-flight resume and
    // return 202, NOT mark the run Failed.
    const { runId, hitlRequestId } = seedPermissionRow({
      runStatus: "NeedsInput",
      response: { optionId: "allow" } as Row,
    });

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("HITL_TIMEOUT", "stale checkpointed deferred"),
    );

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(202);
    // Critical: the run must NOT be Failed.
    expect(dbState.tables.runs[0].status).toBe("NeedsInput");
    // Critical: respondedAt must NOT be set — the in-flight driver
    // will set it once auto-delivery against the new requestId
    // succeeds.
    expect(dbState.tables.hitl_requests[0].respondedAt).toBeNull();
  });

  it("same-payload retry from in-progress state behaves idempotently (claim already 'noop-idempotent') — does not double-spawn", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      runStatus: "NeedsInputIdle",
      response: { optionId: "allow" } as Row,
    });

    // Phase 1 sees stored.optionId === optionId → noop-idempotent.
    // Phase 2 (idle branch) still routes through resumeRun. Test
    // that resumeRun being called once is fine even on a retry —
    // the second call would race on markResumed and the route maps
    // it to 202.
    resumeRunSpy.mockResolvedValueOnce({
      ok: false,
      code: "CLAIM_RACE",
      retryable: false,
      message: "concurrent resume in progress",
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(202);
  });
});

describe("HITL respond route — auth-first ordering", () => {
  it("runs requireActiveSession BEFORE any resource lookup (no shape-leak)", async () => {
    // A forced-password-change caller. The gate MUST fire before the route
    // probes hitl_requests/runs — otherwise a must-change account could read
    // PRECONDITION "not found" shapes off this state-changing endpoint.
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError(
        "PASSWORD_CHANGE_REQUIRED",
        "Password change required before any action",
      ),
    );

    // dbState is empty: if the route looked up the row first it would answer
    // 409 PRECONDITION ("hitl request not found"). Auth-first yields 403.
    const res = await invokePost("ghost-run", "ghost-hitl", {
      optionId: "allow",
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PASSWORD_CHANGE_REQUIRED");
    // No write happened — the handler never reached the claim transaction.
    expect(dbState.updates).toHaveLength(0);
  });
});
