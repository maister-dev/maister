import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireProjectAction } from "@/lib/authz";
import { getRunCostSummary } from "@/lib/queries/run";
import { MaisterError } from "@/lib/errors";
import { loadRunChangeSummaryAccess } from "@/lib/runs/change-summary";

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

vi.mock("@/lib/runs/change-summary", () => ({
  loadRunChangeSummaryAccess: vi.fn(),
}));

vi.mock("@/lib/queries/run", () => ({
  getRunCostSummary: vi.fn(),
}));

const COST = {
  inputTokens: 120,
  outputTokens: 45,
  cacheReadTokens: 9,
  cacheCreationTokens: 3,
  resumeTokens: 0,
  totalTokens: 177,
  byModel: {},
};

async function invokeGet(runId: string) {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/cost-summary`, {
      method: "GET",
    }),
  );

  return GET(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  vi.mocked(requireProjectAction).mockClear();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: {
      id: "user-1",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  });
  vi.mocked(getRunCostSummary).mockReset();
  vi.mocked(getRunCostSummary).mockResolvedValue(COST);
  vi.mocked(loadRunChangeSummaryAccess).mockReset();
});

describe("GET /api/runs/[runId]/cost-summary", () => {
  it("authorizes a flow run with readBoard and returns the cost rollup", async () => {
    vi.mocked(loadRunChangeSummaryAccess).mockResolvedValue({
      runId: "run-1",
      projectId: "project-1",
      runKind: "flow",
    });

    const res = await invokeGet("run-1");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenCalledWith("project-1", "readBoard");
    expect(body).toMatchObject({ totalTokens: 177, inputTokens: 120 });
  });

  it("authorizes a scratch run with readScratchRun", async () => {
    vi.mocked(loadRunChangeSummaryAccess).mockResolvedValue({
      runId: "run-1",
      projectId: "project-1",
      runKind: "scratch",
    });

    const res = await invokeGet("run-1");

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "readScratchRun",
    );
  });

  it("returns 404 for an unknown run", async () => {
    vi.mocked(loadRunChangeSummaryAccess).mockResolvedValue(null);

    const res = await invokeGet("missing");

    expect(res.status).toBe(404);
    expect(getRunCostSummary).not.toHaveBeenCalled();
  });

  it("returns 404 for a project-less local-package assistant run", async () => {
    vi.mocked(loadRunChangeSummaryAccess).mockResolvedValue({
      runId: "run-1",
      projectId: null,
      runKind: "scratch",
    });

    const res = await invokeGet("run-1");

    expect(res.status).toBe(404);
    expect(getRunCostSummary).not.toHaveBeenCalled();
  });

  it("does not read cost when project auth is denied", async () => {
    vi.mocked(loadRunChangeSummaryAccess).mockResolvedValue({
      runId: "run-1",
      projectId: "project-1",
      runKind: "flow",
    });
    vi.mocked(requireProjectAction).mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "denied"),
    );

    const res = await invokeGet("run-1");
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(getRunCostSummary).not.toHaveBeenCalled();
  });
});
