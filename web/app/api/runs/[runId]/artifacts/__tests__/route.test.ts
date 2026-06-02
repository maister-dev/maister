// T6.1 (RED): failing unit tests for GET /api/runs/[runId]/artifacts.
//
// Contract (module not built yet — RED on the missing `../route` import):
//   GET(req, { params: Promise<{ runId }> }) in
//     web/app/api/runs/[runId]/artifacts/route.ts
//   - await requireActiveSession()  (401 on UNAUTHENTICATED)
//   - derive projectId from the RUN ROW (never query/body)
//   - await requireProjectAction(projectId, "readBoard")  (403 on UNAUTHORIZED)
//   - 404 when the run row is absent
//   - 200 { artifacts: ArtifactInstance[] } (full index)
//   - ?node= / ?kind= / ?validity= narrow the list (in-memory filter)

import type { ArtifactInstance } from "@/lib/db/schema";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { runs as runsTable } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { getArtifactsForRun } from "@/lib/flows/graph/artifact-store";

type Row = Record<string, unknown>;
type Tables = { runs: Row[] };

const dbState: { tables: Tables } = { tables: { runs: [] } };

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  throw new Error("unknown table");
}

const selectChain = () => ({
  from: (table: unknown) => ({
    where: async () => dbState.tables[tableOf(table)],
  }),
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
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  })),
}));

vi.mock("@/lib/flows/graph/artifact-store", () => ({
  getArtifactsForRun: vi.fn(async () => [] as ArtifactInstance[]),
}));

const RUN_ID = "run-art-1";
const PROJECT_ID = "project-art-1";

function seedRun(): void {
  dbState.tables.runs.push({
    id: RUN_ID,
    projectId: PROJECT_ID,
    status: "Review",
  });
}

// A mixed artifact set spanning two nodes, two kinds, and two validities so the
// filter assertions have distinguishable subsets.
function mixedArtifacts(): ArtifactInstance[] {
  const base = {
    runId: RUN_ID,
    nodeAttemptId: null,
    attempt: 1,
    artifactDefId: null,
    producer: "projector",
    locator: { kind: "inline", text: "x" },
    uri: null,
    hash: null,
    sizeBytes: null,
    requiredFor: null,
    visibility: "internal",
    retention: "run",
    monotonicId: null,
    supersededById: null,
    createdAt: new Date("2026-06-01T10:00:00Z"),
  } as const;

  return [
    { ...base, id: "a1", nodeId: "implement", kind: "diff", validity: "current" },
    { ...base, id: "a2", nodeId: "implement", kind: "log", validity: "stale" },
    { ...base, id: "a3", nodeId: "checks", kind: "log", validity: "current" },
  ] as unknown as ArtifactInstance[];
}

async function invokeGet(
  runId: string,
  query: Record<string, string> = {},
) {
  const { GET } = await import("../route");
  const qs = new URLSearchParams(query).toString();
  const url = `http://localhost/api/runs/${runId}/artifacts${qs ? `?${qs}` : ""}`;
  const req = new NextRequest(new Request(url, { method: "GET" }));

  return GET(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  dbState.tables = { runs: [] };

  vi.mocked(requireActiveSession).mockClear();
  vi.mocked(requireActiveSession).mockResolvedValue({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  } as never);

  vi.mocked(requireProjectAction).mockClear();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: {
      id: "user-1",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  } as never);

  vi.mocked(getArtifactsForRun).mockClear();
  vi.mocked(getArtifactsForRun).mockResolvedValue(mixedArtifacts());
});

describe("GET /api/runs/[runId]/artifacts", () => {
  it("returns 401 when the session is not active", async () => {
    seedRun();
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );

    const res = await invokeGet(RUN_ID);

    expect(res.status).toBe(401);
    expect(getArtifactsForRun).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks readBoard on the run's project", async () => {
    seedRun();
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeGet(RUN_ID);

    expect(res.status).toBe(403);
    expect(getArtifactsForRun).not.toHaveBeenCalled();
  });

  it("returns 404 when the run does not exist", async () => {
    // No seedRun(): the runs table is empty.
    const res = await invokeGet("nope");

    expect(res.status).toBe(404);
    expect(getArtifactsForRun).not.toHaveBeenCalled();
  });

  it("derives projectId from the run row and authorizes against it", async () => {
    seedRun();

    const res = await invokeGet(RUN_ID);

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenCalledWith(PROJECT_ID, "readBoard");
  });

  it("returns 200 with the full artifact index for the run", async () => {
    seedRun();

    const res = await invokeGet(RUN_ID);
    const body = (await res.json()) as { artifacts: ArtifactInstance[] };

    expect(res.status).toBe(200);
    expect(body.artifacts.map((a) => a.id).sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("filters by ?node=", async () => {
    seedRun();

    const res = await invokeGet(RUN_ID, { node: "implement" });
    const body = (await res.json()) as { artifacts: ArtifactInstance[] };

    expect(res.status).toBe(200);
    expect(body.artifacts.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
  });

  it("filters by ?kind=", async () => {
    seedRun();

    const res = await invokeGet(RUN_ID, { kind: "log" });
    const body = (await res.json()) as { artifacts: ArtifactInstance[] };

    expect(res.status).toBe(200);
    expect(body.artifacts.map((a) => a.id).sort()).toEqual(["a2", "a3"]);
  });

  it("filters by ?validity=", async () => {
    seedRun();

    const res = await invokeGet(RUN_ID, { validity: "current" });
    const body = (await res.json()) as { artifacts: ArtifactInstance[] };

    expect(res.status).toBe(200);
    expect(body.artifacts.map((a) => a.id).sort()).toEqual(["a1", "a3"]);
  });

  it("combines filters (AND semantics)", async () => {
    seedRun();

    const res = await invokeGet(RUN_ID, { node: "implement", kind: "log" });
    const body = (await res.json()) as { artifacts: ArtifactInstance[] };

    expect(res.status).toBe(200);
    expect(body.artifacts.map((a) => a.id)).toEqual(["a2"]);
  });

  it("projects to the DTO whitelist — strips internal columns (monotonicId, supersededById)", async () => {
    seedRun();

    // A row carrying the internal-only columns the DTO must NOT leak.
    vi.mocked(getArtifactsForRun).mockResolvedValueOnce([
      {
        id: "a1",
        runId: RUN_ID,
        nodeAttemptId: "att-1",
        nodeId: "implement",
        attempt: 1,
        artifactDefId: "workspace-diff",
        kind: "diff",
        producer: "runner",
        locator: { kind: "inline", text: "x" },
        uri: null,
        hash: null,
        sizeBytes: 4096,
        validity: "current",
        requiredFor: ["review"],
        visibility: "shared",
        retention: "run",
        monotonicId: 7,
        supersededById: "art-old",
        createdAt: new Date("2026-06-01T10:00:00Z"),
      },
    ] as unknown as ArtifactInstance[]);

    const res = await invokeGet(RUN_ID);
    const body = (await res.json()) as { artifacts: Record<string, unknown>[] };

    expect(res.status).toBe(200);

    const artifact = body.artifacts[0];

    // Internal columns must NOT be present as own properties.
    expect(artifact).not.toHaveProperty("monotonicId");
    expect(artifact).not.toHaveProperty("supersededById");

    // The declared DTO fields (OpenAPI ArtifactInstance whitelist) must remain.
    for (const field of [
      "id",
      "runId",
      "nodeAttemptId",
      "nodeId",
      "attempt",
      "artifactDefId",
      "kind",
      "producer",
      "locator",
      "uri",
      "hash",
      "sizeBytes",
      "validity",
      "requiredFor",
      "visibility",
      "retention",
      "createdAt",
    ]) {
      expect(artifact).toHaveProperty(field);
    }
  });
});
