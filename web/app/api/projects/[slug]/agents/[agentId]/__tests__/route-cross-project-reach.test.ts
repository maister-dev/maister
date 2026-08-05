import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

// T24/T25 (ADR-156): `crossProjectReach` rides the EXISTING aggregating PATCH —
// one transactional endpoint with a partial body, never a per-field route and
// never a client-side fan-out. SET and CLEAR are both explicit; an absent field
// leaves the grant untouched. Because the grant travels in the same call as
// `schedulesRevision`, the existing fence covers it: a stale editor cannot
// re-grant reach off a view that has since changed.

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  projectRows: [] as unknown[],
  updateAgentLink: vi.fn(),
  detachAgent: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: async () => mocks.projectRows }),
    }),
  }),
}));
vi.mock("@/lib/agents/project-links", () => ({
  updateAgentLink: mocks.updateAgentLink,
  detachAgent: mocks.detachAgent,
}));

const params = (agentId = "core:triager") => ({
  params: Promise.resolve({ slug: "proj", agentId }),
});

function jsonRequest(
  method: string,
  body?: Record<string, unknown>,
): NextRequest {
  return new Request("http://x/api/projects/proj/agents/core:triager", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as NextRequest;
}

function lastPatch(): Record<string, unknown> {
  const call = mocks.updateAgentLink.mock.calls.at(-1)?.[0] as {
    patch: Record<string, unknown>;
  };

  return call.patch;
}

let route: typeof import("../route");

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "admin" });
  mocks.projectRows = [{ id: "project-1", archivedAt: null }];
  mocks.updateAgentLink.mockResolvedValue(undefined);

  route = await import("../route");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/projects/[slug]/agents/[agentId] cross-project reach (ADR-156)", () => {
  it("forwards an explicit grant (SET) in the ONE aggregating call", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", { crossProjectReach: true }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "editSettings",
    );
    expect(mocks.updateAgentLink).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgentLink).toHaveBeenCalledWith({
      projectId: "project-1",
      agentId: "core:triager",
      // ADR-157: the acting operator rides along so the service can authorize
      // `contextRepos` against each sibling project at WRITE time.
      actorUserId: "user-1",
      patch: { crossProjectReach: true },
    });
  });

  it("forwards an explicit revoke (CLEAR) rather than dropping a false", async () => {
    await route.PATCH(
      jsonRequest("PATCH", { crossProjectReach: false }),
      params(),
    );

    expect(lastPatch()).toEqual({ crossProjectReach: false });
  });

  it("omits the field when absent, leaving the grant untouched", async () => {
    await route.PATCH(jsonRequest("PATCH", { enabled: true }), params());

    const patch = lastPatch();

    expect(patch).toEqual({ enabled: true });
    expect(
      Object.prototype.hasOwnProperty.call(patch, "crossProjectReach"),
    ).toBe(false);
  });

  it("rides the same body and the same call as the fenced schedule replacement", async () => {
    await route.PATCH(
      jsonRequest("PATCH", {
        enabled: true,
        crossProjectReach: true,
        schedulesRevision: 3,
        schedules: [{ triggerType: "mention", enabled: true }],
      }),
      params(),
    );

    expect(mocks.updateAgentLink).toHaveBeenCalledTimes(1);
    expect(lastPatch()).toEqual({
      enabled: true,
      crossProjectReach: true,
      schedulesRevision: 3,
      schedules: [{ triggerType: "mention", enabled: true }],
    });
  });

  it("refuses a stale schedulesRevision with 409 CONFLICT — no silent re-grant", async () => {
    mocks.updateAgentLink.mockRejectedValue(
      new MaisterError(
        "CONFLICT",
        "agent schedule bindings have changed; reload before saving",
      ),
    );

    const res = await route.PATCH(
      jsonRequest("PATCH", {
        crossProjectReach: true,
        schedulesRevision: 1,
        schedules: [],
      }),
      params(),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
  });

  it("refuses a schedules replacement that carries no revision, before any write", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", { crossProjectReach: true, schedules: [] }),
      params(),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");
    expect(mocks.updateAgentLink).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean grant with 422 CONFIG before any write", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", { crossProjectReach: "yes" }),
      params(),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");
    expect(mocks.updateAgentLink).not.toHaveBeenCalled();
  });

  it("refuses a non-editor before any write", async () => {
    mocks.requireProjectAction.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "requires admin"),
    );

    const res = await route.PATCH(
      jsonRequest("PATCH", { crossProjectReach: true }),
      params(),
    );

    expect(res.status).toBe(403);
    expect(mocks.updateAgentLink).not.toHaveBeenCalled();
  });
});

// ADR-157 T28/T29: `contextRepos` rides the same aggregating PATCH. SET/CLEAR
// symmetry is the invariant this repo gets wrong most often — an
// `if (!x) continue` write loop leaves the old value in place after the operator
// removes the field, while every reader believes "absent = none". Both halves
// plus absent-is-untouched are asserted.
describe("PATCH /api/projects/[slug]/agents/[agentId] context repos (ADR-157)", () => {
  it("forwards a declaration (SET)", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", {
        contextRepos: [{ project: "api-service", ref: "main" }],
      }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(lastPatch().contextRepos).toEqual([
      { project: "api-service", ref: "main" },
    ]);
  });

  it("forwards an explicit null (CLEAR) — the other half of the contract", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", { contextRepos: null }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(lastPatch().contextRepos).toBeNull();
  });

  it("omits the key entirely when absent, leaving the declaration untouched", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", { enabled: true }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(lastPatch()).not.toHaveProperty("contextRepos");
  });

  it("refuses more than 8 entries before any write", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", {
        contextRepos: Array.from({ length: 9 }, (_, i) => ({
          project: `sib-${i}`,
        })),
      }),
      params(),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.updateAgentLink).not.toHaveBeenCalled();
  });

  it("refuses an unknown key inside an entry before any write", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", {
        contextRepos: [{ project: "api-service", branch: "main" }],
      }),
      params(),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.updateAgentLink).not.toHaveBeenCalled();
  });

  // There is no launching user for an agent run, so attach IS the consent
  // event: the service authorizes each sibling at write time and the route
  // must surface that as the domain refusal, not a 500.
  it("surfaces the service's write-time PRECONDITION", async () => {
    mocks.updateAgentLink.mockRejectedValue(
      new MaisterError(
        "PRECONDITION",
        'contextRepos: you lack readRepoFiles on project "api-service"',
      ),
    );

    const res = await route.PATCH(
      jsonRequest("PATCH", { contextRepos: [{ project: "api-service" }] }),
      params(),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "PRECONDITION" });
  });
});
