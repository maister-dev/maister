// Unit tests for the per-node transcript route (T-B3).
//
// Contract:
//   GET /api/runs/[runId]/transcript?node={nodeId}
//   requireActiveSession()
//   detail = getRunDetail(runId); !detail → bare 404 {message}
//   requireProjectAction(detail.projectId, "readRepoFiles")   (MEMBER, not viewer)
//   node missing → 400 {code:"CONFIG"}
//   node not in compiled graph → 409 {code:"PRECONDITION"}
//   else projectRunTranscript(runId) + getRunNodeTranscript(runId, node)
//        → 200 {messages, usage}, no internal handles leaked.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import { getRunDetail } from "@/lib/queries/run";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import {
  getRunNodeTranscript,
  projectRunTranscript,
} from "@/lib/runs/run-transcript-projector";

const RUN_ID = "run-1";
const PROJECT_ID = "project-1";

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

vi.mock("@/lib/queries/run", () => ({ getRunDetail: vi.fn() }));
vi.mock("@/lib/queries/run-manifest", () => ({ loadRunManifest: vi.fn() }));
vi.mock("@/lib/flows/graph/compile", () => ({ compileManifest: vi.fn() }));
vi.mock("@/lib/runs/run-transcript-projector", () => ({
  projectRunTranscript: vi.fn(),
  getRunNodeTranscript: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireActiveSession).mockResolvedValue({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  } as unknown as Awaited<ReturnType<typeof requireActiveSession>>);
  vi.mocked(requireProjectAction).mockResolvedValue(
    {} as unknown as Awaited<ReturnType<typeof requireProjectAction>>,
  );
  vi.mocked(getRunDetail).mockResolvedValue({
    runId: RUN_ID,
    projectId: PROJECT_ID,
  } as unknown as Awaited<ReturnType<typeof getRunDetail>>);
  vi.mocked(loadRunManifest).mockResolvedValue({
    manifest: {},
  } as unknown as Awaited<ReturnType<typeof loadRunManifest>>);
  vi.mocked(compileManifest).mockReturnValue({
    nodes: new Map([["implement", {}]]),
  } as unknown as ReturnType<typeof compileManifest>);
  vi.mocked(projectRunTranscript).mockResolvedValue({
    status: "projected",
    nodeAttempts: 1,
    rowsUpserted: 1,
  });
  vi.mocked(getRunNodeTranscript).mockResolvedValue({
    messages: [
      {
        id: "m1",
        role: "assistant",
        content: "done",
        createdAt: "2026-06-29T00:00:00.000Z",
      },
    ],
    usage: { used: 100, size: 200000 },
  });
});

async function invoke(runId: string, node?: string) {
  const { GET } = await import("../route");
  const url =
    node === undefined
      ? `http://localhost/api/runs/${runId}/transcript`
      : `http://localhost/api/runs/${runId}/transcript?node=${encodeURIComponent(node)}`;
  const req = new NextRequest(new Request(url, { method: "GET" }));

  return GET(req, { params: Promise.resolve({ runId }) });
}

describe("GET /api/runs/[runId]/transcript", () => {
  it("returns 200 {messages, usage} for a valid node and reconciles first", async () => {
    const res = await invoke(RUN_ID, "implement");
    const body = (await res.json()) as {
      messages: { role: string; content: string }[];
      usage: { used: number } | null;
    };

    expect(res.status).toBe(200);
    expect(projectRunTranscript).toHaveBeenCalledWith(RUN_ID);
    expect(getRunNodeTranscript).toHaveBeenCalledWith(RUN_ID, "implement");
    expect(body.messages).toHaveLength(1);
    expect(body.usage).toMatchObject({ used: 100 });
  });

  it("authorizes with (detail.projectId, 'readRepoFiles') — not a viewer gate", async () => {
    await invoke(RUN_ID, "implement");

    expect(requireProjectAction).toHaveBeenCalledWith(
      PROJECT_ID,
      "readRepoFiles",
    );
  });

  it("returns 404 when the run does not exist", async () => {
    vi.mocked(getRunDetail).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getRunDetail>>,
    );

    const res = await invoke(RUN_ID, "implement");

    expect(res.status).toBe(404);
    expect(projectRunTranscript).not.toHaveBeenCalled();
  });

  it("returns 403 when requireProjectAction rejects (viewer/non-member)", async () => {
    vi.mocked(requireProjectAction).mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "not a member"),
    );

    const res = await invoke(RUN_ID, "implement");

    expect(res.status).toBe(403);
    expect(projectRunTranscript).not.toHaveBeenCalled();
  });

  it("returns 400 CONFIG when ?node is missing", async () => {
    const res = await invoke(RUN_ID);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
  });

  it("returns 409 PRECONDITION for a node not in the compiled graph", async () => {
    const res = await invoke(RUN_ID, "bogus-node");
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(projectRunTranscript).not.toHaveBeenCalled();
  });

  it("does not leak internal handles in the payload", async () => {
    vi.mocked(getRunNodeTranscript).mockResolvedValue({
      messages: [
        {
          id: "m1",
          role: "tool",
          content: JSON.stringify({ v: 1, kind: "tool", name: "read" }),
          createdAt: "2026-06-29T00:00:00.000Z",
        },
      ],
      usage: null,
    });

    const res = await invoke(RUN_ID, "implement");
    const text = await res.text();

    expect(text).not.toContain("acpSessionId");
    expect(text).not.toContain("acp_session_id");
  });
});
