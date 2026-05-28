import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: async (fn: (tx: any) => Promise<void>) => {
    await fn({
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
    schema: { fields: [] },
    response: null,
    respondedAt: overrides.respondedAt ?? null,
  });

  return { runId, hitlRequestId, stepId: "review" };
}

async function invokePost(
  runId: string,
  hitlRequestId: string,
  body: unknown,
) {
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
    expect(deliverPermissionSpy).toHaveBeenCalledWith("sup-1", "req-1", "allow");
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

  it("retry after EXECUTOR_UNAVAILABLE with a different optionId overwrites response and succeeds", async () => {
    const { runId, hitlRequestId } = seedPermissionRow();

    deliverPermissionSpy.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "no supervisor"),
    );

    const first = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(first.status).toBe(503);

    const second = await invokePost(runId, hitlRequestId, {
      optionId: "deny",
    });

    expect(second.status).toBe(200);
    expect(dbState.tables.hitl_requests[0].response).toEqual({
      optionId: "deny",
    });
    expect(deliverPermissionSpy).toHaveBeenNthCalledWith(2, "sup-1", "req-1", "deny");
  });

  it("already-delivered (respondedAt set) → 409", async () => {
    const { runId, hitlRequestId } = seedPermissionRow({
      respondedAt: new Date(),
    });

    const res = await invokePost(runId, hitlRequestId, { optionId: "allow" });

    expect(res.status).toBe(409);
    expect(deliverPermissionSpy).not.toHaveBeenCalled();
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
    expect(dbState.tables.runs[0].status).toBe("Running");
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
