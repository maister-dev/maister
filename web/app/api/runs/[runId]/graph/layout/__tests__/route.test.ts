import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { runs as runsTable } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { upsertNodeLayout } from "@/lib/runs/flow-layout-write";

type Row = Record<string, unknown>;

const dbState: { runs: Row[] } = { runs: [] };

function tableOf(t: unknown): "runs" {
  if (t === runsTable) return "runs";
  throw new Error("unknown table");
}

const selectChain = () => ({
  from: (table: unknown) => {
    tableOf(table);

    return {
      where: async () => dbState.runs,
    };
  },
});

const fakeDb = { select: selectChain };

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: {
      id: "user-1",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "member",
  })),
}));

vi.mock("@/lib/runs/flow-layout-write", () => ({
  upsertNodeLayout: vi.fn(async () => ({ ok: true })),
}));

function seedRun(): string {
  const runId = "run-layout";

  dbState.runs.push({
    id: runId,
    projectId: "project-1",
    flowId: "flow-1",
    status: "Running",
  });

  return runId;
}

async function invokePut(runId: string, body: unknown) {
  const { PUT } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/graph/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return PUT(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  dbState.runs = [];

  vi.mocked(requireActiveSession).mockClear();
  vi.mocked(requireActiveSession).mockResolvedValue({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  });

  vi.mocked(requireProjectAction).mockClear();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: {
      id: "user-1",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "member",
  });

  vi.mocked(upsertNodeLayout).mockClear();
  vi.mocked(upsertNodeLayout).mockResolvedValue({ ok: true });
});

describe("PUT /api/runs/[runId]/graph/layout", () => {
  it("upserts a node position and returns 200 { ok: true }", async () => {
    const runId = seedRun();

    const res = await invokePut(runId, { nodeId: "plan", x: 12, y: 34 });
    const body = (await res.json()) as { ok?: boolean };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(upsertNodeLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        nodeId: "plan",
        x: 12,
        y: 34,
        userId: "user-1",
      }),
    );
  });

  it("returns 404 (not the project action) when the run row is absent", async () => {
    const res = await invokePut("missing-run", { nodeId: "plan", x: 1, y: 2 });

    expect(res.status).toBe(404);
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(upsertNodeLayout).not.toHaveBeenCalled();
  });

  it("returns 401 when the session is not authenticated", async () => {
    const runId = seedRun();

    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "sign in"),
    );

    const res = await invokePut(runId, { nodeId: "plan", x: 1, y: 2 });

    expect(res.status).toBe(401);
    expect(upsertNodeLayout).not.toHaveBeenCalled();
  });

  it("returns 403 when the project action is unauthorized", async () => {
    const runId = seedRun();

    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a member"),
    );

    const res = await invokePut(runId, { nodeId: "plan", x: 1, y: 2 });

    expect(res.status).toBe(403);
    expect(upsertNodeLayout).not.toHaveBeenCalled();
  });

  it("returns 400 on a malformed body (missing nodeId)", async () => {
    const runId = seedRun();

    const res = await invokePut(runId, { x: 1, y: 2 });

    expect(res.status).toBe(400);
    expect(upsertNodeLayout).not.toHaveBeenCalled();
  });

  it("returns 400 on a malformed body (non-number x)", async () => {
    const runId = seedRun();

    const res = await invokePut(runId, { nodeId: "plan", x: "nope", y: 2 });

    expect(res.status).toBe(400);
    expect(upsertNodeLayout).not.toHaveBeenCalled();
  });

  it("returns 400 when upsertNodeLayout rejects CONFIG", async () => {
    const runId = seedRun();

    vi.mocked(upsertNodeLayout).mockRejectedValueOnce(
      new MaisterError("CONFIG", 'unknown node "ghost"'),
    );

    const res = await invokePut(runId, { nodeId: "ghost", x: 1, y: 2 });

    expect(res.status).toBe(400);
  });
});
