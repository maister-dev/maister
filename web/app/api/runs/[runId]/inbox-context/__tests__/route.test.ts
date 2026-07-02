import type { InboxCardContext } from "@/lib/queries/inbox-context";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { runs as runsTable } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { getInboxCardContext } from "@/lib/queries/inbox-context";

// The route is a thin auth-copy of the diff route (mirrors its fakeDb +
// mocked-authz pattern). It loads the run, derives projectId from the run row,
// gates `readBoard`, then delegates the peek to getInboxCardContext. These cases
// pin the authorization boundary (401/403/404) and the server-state wiring that
// the inbox-card-redesign plan (T1.2) promised but never landed.

type Row = Record<string, unknown>;
const dbState: { runs: Row[] } = { runs: [] };

const selectChain = () => ({
  from: (table: unknown) => {
    if (table !== runsTable) throw new Error("unknown table");
    const rows = dbState.runs;
    const chain: Record<string, unknown> = {
      then: (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled),
      where: () => chain,
    };

    return chain;
  },
});

vi.mock("@/lib/db/client", () => ({ getDb: () => ({ select: selectChain }) }));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: { id: "user-1", role: "viewer" },
    role: "viewer",
  })),
}));

vi.mock("@/lib/queries/inbox-context", () => ({
  getInboxCardContext: vi.fn(),
}));

const SAMPLE_CONTEXT: InboxCardContext = {
  lastAgentMessage: {
    text: "Need a call on the migration.",
    at: "2026-06-01T10:00:00.000Z",
  },
  gates: [
    {
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "failed",
    },
  ],
  diff: { files: 2, additions: 10, deletions: 3 },
  progress: { done: 1, total: 4 },
  budgetProgress: null,
  availableOptions: [],
  claimStage: null,
};

function seedRun(overrides: Partial<Row> = {}): string {
  const runId = "run-inbox";

  dbState.runs.push({
    id: runId,
    projectId: "project-1",
    currentStepId: "checks",
    flowRevisionId: null,
    flowId: "flow-1",
    ...overrides,
  });

  return runId;
}

async function invokeGet(runId: string) {
  const { GET } = await import("../route");

  return GET(new Request(`http://localhost/api/runs/${runId}/inbox-context`), {
    params: Promise.resolve({ runId }),
  });
}

beforeEach(() => {
  dbState.runs = [];
  vi.mocked(requireActiveSession).mockClear();
  vi.mocked(requireActiveSession).mockResolvedValue({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  } as never);
  vi.mocked(requireProjectAction).mockClear();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: { id: "user-1", role: "viewer" },
    role: "viewer",
  } as never);
  vi.mocked(getInboxCardContext).mockClear();
  vi.mocked(getInboxCardContext).mockResolvedValue(SAMPLE_CONTEXT);
});

describe("GET /api/runs/[runId]/inbox-context", () => {
  it("returns 200 with the card context and gates readBoard on the run's project", async () => {
    const runId = seedRun();

    const res = await invokeGet(runId);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(SAMPLE_CONTEXT);
    expect(requireProjectAction).toHaveBeenCalledWith("project-1", "readBoard");
  });

  it("derives the run-scoped fields from server state (never a body field)", async () => {
    const runId = seedRun({
      currentStepId: "review",
      flowRevisionId: "rev-9",
      flowId: "flow-1",
    });

    await invokeGet(runId);

    expect(getInboxCardContext).toHaveBeenCalledWith({
      id: runId,
      projectId: "project-1",
      currentStepId: "review",
      flowRevisionId: "rev-9",
      flowId: "flow-1",
    });
  });

  it("returns 404 for an unknown run without touching authz or the peek", async () => {
    const res = await invokeGet("does-not-exist");

    expect(res.status).toBe(404);
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(getInboxCardContext).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is denied readBoard on a foreign run", async () => {
    const runId = seedRun();

    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeGet(runId);

    expect(res.status).toBe(403);
    expect(getInboxCardContext).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no active session", async () => {
    const runId = seedRun();

    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "no session"),
    );

    const res = await invokeGet(runId);

    expect(res.status).toBe(401);
    expect(getInboxCardContext).not.toHaveBeenCalled();
  });
});
