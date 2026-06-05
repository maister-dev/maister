import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { getRunNodeStatuses } from "@/lib/queries/run-node-status";
import { loadRunManifest } from "@/lib/queries/run-manifest";

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
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  })),
}));

vi.mock("@/lib/queries/run-manifest", () => ({
  loadRunManifest: vi.fn(),
}));

vi.mock("@/lib/queries/run-node-status", () => ({
  getRunNodeStatuses: vi.fn(),
}));

const SNAPSHOT = {
  currentStepId: "review",
  runStatus: "NeedsInput",
  nodes: {
    implement: { status: "Succeeded", attempt: 2, gates: [], rollup: "none" },
    review: {
      status: "NeedsInput",
      attempt: 1,
      gates: [{ blocking: true, status: "passed" }],
      rollup: "passed",
    },
  },
};

async function invokeGet(runId: string) {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/graph-status`, {
      method: "GET",
    }),
  );

  return GET(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  vi.mocked(requireActiveSession).mockReset();
  vi.mocked(requireActiveSession).mockResolvedValue({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  });

  vi.mocked(requireProjectAction).mockReset();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: {
      id: "user-1",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  });

  vi.mocked(loadRunManifest).mockReset();
  vi.mocked(loadRunManifest).mockResolvedValue({
    flowId: "flow-1",
    projectId: "project-1",
    manifest: { schemaVersion: 1, name: "aif", steps: [] } as never,
  } as never);

  vi.mocked(getRunNodeStatuses).mockReset();
  vi.mocked(getRunNodeStatuses).mockResolvedValue(SNAPSHOT as never);
});

describe("GET /api/runs/[runId]/graph-status", () => {
  it("returns 200 with the { currentStepId, runStatus, nodes } snapshot", async () => {
    const res = await invokeGet("run-1");
    const body = (await res.json()) as typeof SNAPSHOT;

    expect(res.status).toBe(200);
    expect(body).toEqual(SNAPSHOT);
    expect(getRunNodeStatuses).toHaveBeenCalledWith("run-1");
  });

  it("authorizes the run's server-derived project (readBoard) before reading statuses", async () => {
    await invokeGet("run-1");

    expect(requireProjectAction).toHaveBeenCalledWith("project-1", "readBoard");
  });

  it("returns 404 (not the project action) when loadRunManifest is null", async () => {
    vi.mocked(loadRunManifest).mockResolvedValueOnce(null);

    const res = await invokeGet("missing-run");

    expect(res.status).toBe(404);
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(getRunNodeStatuses).not.toHaveBeenCalled();
  });

  it("returns 401 when the session is not authenticated", async () => {
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "sign in"),
    );

    const res = await invokeGet("run-1");

    expect(res.status).toBe(401);
    expect(loadRunManifest).not.toHaveBeenCalled();
  });

  it("returns 403 when the project action is unauthorized and reads no statuses", async () => {
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a member"),
    );

    const res = await invokeGet("run-1");

    expect(res.status).toBe(403);
    expect(getRunNodeStatuses).not.toHaveBeenCalled();
  });
});
