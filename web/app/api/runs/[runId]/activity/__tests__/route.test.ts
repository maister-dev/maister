import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked db chain: select returns the seeded `runRow`; update.set.where
// returns a row with id (so bumpKeepalive returns ok:true). `bumped` records
// that the state-changing write actually ran — the auth tests below are about
// proving it does NOT.
const state: {
  runRow: Record<string, unknown> | null;
  bumped: boolean;
} = { runRow: null, bumped: false };

function bumped(): boolean {
  return state.bumped;
}

const selectChain = () => ({
  from: () => ({
    where: async () => (state.runRow ? [state.runRow] : []),
  }),
});

const updateChain = (_table: unknown) => ({
  set: () => ({
    where: () => ({
      returning: async () => {
        state.bumped = true;

        return state.runRow ? [{ id: state.runRow.id }] : [];
      },
    }),
  }),
});

const fakeDb = {
  select: () => selectChain(),
  update: updateChain,
};

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

// Only the two session-touching entry points are stubbed: `requireActiveSession`
// reaches `getSessionUser`, which dynamically imports @/auth → next-auth →
// next/server (an ESM path vitest cannot resolve). `httpStatusForAuthz` stays
// REAL — mapping codes to statuses is what these assertions are about, and a
// hand-written mock of it would just assert itself.
const authz = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectRole: vi.fn(),
}));

vi.mock("@/lib/authz", async (orig) => {
  const actual = await orig<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: authz.requireActiveSession,
    requireProjectRole: authz.requireProjectRole,
  };
});

const assertLocalPackageAssistantActor = vi.hoisted(() => vi.fn());

vi.mock("@/lib/scratch-runs/service", () => ({
  assertLocalPackageAssistantActor,
}));

let POST: (
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) => Promise<Response>;
// `isMaisterError` is an instanceof check, and `vi.resetModules()` hands the
// route a FRESH errors-core. A MaisterError built from a top-level import would
// be a different class than the one the route tests against, so its typed
// refusals would escape as 500s. Take the class from the same graph.
let MaisterError: typeof import("@/lib/errors").MaisterError;

beforeEach(async () => {
  state.runRow = null;
  state.bumped = false;
  authz.requireActiveSession.mockReset().mockResolvedValue({ id: "user-1" });
  authz.requireProjectRole.mockReset().mockResolvedValue(undefined);
  assertLocalPackageAssistantActor.mockReset().mockResolvedValue(undefined);
  ({ POST } = await import("../route"));
  ({ MaisterError } = await import("@/lib/errors"));
});

afterEach(() => {
  vi.resetModules();
});

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

function reqCtx(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

async function makeReq(): Promise<Request> {
  return new Request("http://x/api/runs/activity", { method: "POST" });
}

describe("POST /api/runs/[runId]/activity — M8 T7", () => {
  it("rejects non-UUID runId with 400", async () => {
    const res = await POST(await makeReq(), reqCtx("not-a-uuid"));

    expect(res.status).toBe(400);
  });

  it("returns 404 when run is missing", async () => {
    state.runRow = null;
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(404);
  });

  it("returns 204 on Running", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-1", status: "Running" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(204);
  });

  it("returns 204 on NeedsInput", async () => {
    state.runRow = {
      id: VALID_UUID,
      projectId: "proj-1",
      status: "NeedsInput",
    };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(204);
  });

  it("returns 409 with nextAction:respond on NeedsInputIdle", async () => {
    state.runRow = {
      id: VALID_UUID,
      projectId: "proj-1",
      status: "NeedsInputIdle",
    };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { nextAction?: string };

    expect(body.nextAction).toBe("respond");
  });

  it("returns 410 on Done", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-1", status: "Done" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 410 on Failed", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-1", status: "Failed" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 410 on Crashed", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-1", status: "Crashed" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 410 on Abandoned", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-1", status: "Abandoned" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 410 on Review", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-1", status: "Review" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 409 on Pending (not yet live)", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-1", status: "Pending" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(409);
  });
});

// This route shipped with NO auth at all: a leaked run id gave any anonymous
// caller a status oracle (the 404/409/410/204 shapes discriminate) AND an
// unauthenticated state-changing write — bumpKeepalive extends keepalive_until
// indefinitely, defeating the idle-checkpoint cost control (~$0.28 of
// cache_creation per respawn) and pinning the run's slot against the global cap.
describe("POST /api/runs/[runId]/activity — authorization", () => {
  it("401s an unauthenticated caller BEFORE any run lookup (no status oracle)", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-1", status: "Running" };
    authz.requireActiveSession.mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "no session"),
    );

    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(401);
    // The decisive part: no keepalive was bumped, and the response cannot be
    // told apart from one for a run that does not exist.
    expect(bumped()).toBe(false);
  });

  it("403s a caller without viewer on the run's project, and does not bump", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-1", status: "Running" };
    authz.requireProjectRole.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "not a member"),
    );

    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(403);
    expect(bumped()).toBe(false);
  });

  it("authorizes against the SERVER-DERIVED project of the run row", async () => {
    state.runRow = { id: VALID_UUID, projectId: "proj-42", status: "Running" };

    await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(authz.requireProjectRole).toHaveBeenCalledWith("proj-42", "viewer");
  });

  it("treats a project-less local-package run as private to its launcher", async () => {
    state.runRow = {
      id: VALID_UUID,
      projectId: null,
      status: "Running",
      createdByUserId: "user-1",
      localPackageId: "pkg-1",
    };

    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(204);
    expect(assertLocalPackageAssistantActor).toHaveBeenCalled();
    expect(authz.requireProjectRole).not.toHaveBeenCalled();
  });

  it("403s a project-less run when the caller is not its launcher", async () => {
    state.runRow = {
      id: VALID_UUID,
      projectId: null,
      status: "Running",
      createdByUserId: "someone-else",
      localPackageId: "pkg-1",
    };
    assertLocalPackageAssistantActor.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "not the launching user"),
    );

    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(403);
    expect(bumped()).toBe(false);
  });
});
