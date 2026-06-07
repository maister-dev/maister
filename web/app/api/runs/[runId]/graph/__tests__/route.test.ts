import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
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

vi.mock("@/lib/queries/flow-graph-view", () => ({
  buildGraphTopology: vi.fn(),
}));

vi.mock("@/lib/flows/graph/compile", () => ({
  compileManifest: vi.fn(() => ({
    entry: "plan",
    order: ["plan"],
    nodes: new Map(),
  })),
}));

const TOPOLOGY = {
  nodes: [{ id: "plan", nodeType: "ai_coding", label: "plan" }],
  edges: [
    { id: "plan:success", source: "plan", target: "done", outcome: "success" },
  ],
};
const LAYOUT = { plan: { x: 10, y: 20 } };
// Authored layout (ADR-064): the route derives `layout` from the manifest's
// presentation section via the real presentationLayout projection.
const MANIFEST = {
  schemaVersion: 1,
  name: "aif",
  steps: [],
  presentation: { nodes: [{ id: "plan", x: 10, y: 20 }] },
};

async function invokeGet(runId: string) {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/graph`, { method: "GET" }),
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
    manifest: MANIFEST as never,
  } as never);

  vi.mocked(buildGraphTopology).mockReset();
  vi.mocked(buildGraphTopology).mockReturnValue(TOPOLOGY as never);
});

describe("GET /api/runs/[runId]/graph", () => {
  it("returns 200 with { topology, layout }", async () => {
    const res = await invokeGet("run-1");
    const body = (await res.json()) as {
      topology?: typeof TOPOLOGY;
      layout?: typeof LAYOUT;
    };

    expect(res.status).toBe(200);
    expect(Array.isArray(body.topology?.nodes)).toBe(true);
    expect(Array.isArray(body.topology?.edges)).toBe(true);
    expect(body.topology).toEqual(TOPOLOGY);
    expect(body.layout).toEqual(LAYOUT);
  });

  it("authorizes the run's server-derived project before reading graph data", async () => {
    await invokeGet("run-1");

    expect(requireProjectAction).toHaveBeenCalledWith("project-1", "readBoard");
  });

  it("returns 404 (not the project action) when loadRunManifest is null", async () => {
    vi.mocked(loadRunManifest).mockResolvedValueOnce(null);

    const res = await invokeGet("missing-run");

    expect(res.status).toBe(404);
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(buildGraphTopology).not.toHaveBeenCalled();
  });

  it("returns 401 when the session is not authenticated", async () => {
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "sign in"),
    );

    const res = await invokeGet("run-1");

    expect(res.status).toBe(401);
    expect(loadRunManifest).not.toHaveBeenCalled();
  });

  it("returns 403 when the project action is unauthorized and reads no graph data", async () => {
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a member"),
    );

    const res = await invokeGet("run-1");

    expect(res.status).toBe(403);
    expect(buildGraphTopology).not.toHaveBeenCalled();
  });
});
