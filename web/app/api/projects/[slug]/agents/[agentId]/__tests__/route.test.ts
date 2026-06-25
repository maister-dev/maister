import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

// P1.5 (ADR-111): the PATCH route folds `configValues` into the SAME aggregating
// `updateAgentLink` call, remapping the wire field to the service/column key
// `config` (SET = object, CLEAR = explicit null), and validates the body shape.

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

let route: typeof import("../route");

beforeEach(async () => {
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  mocks.projectRows = [{ id: "project-1", archivedAt: null }];
  mocks.updateAgentLink.mockResolvedValue(undefined);

  route = await import("../route");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/projects/[slug]/agents/[agentId] config (ADR-111)", () => {
  it("forwards configValues as patch.config (SET) in the aggregating call", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", {
        configValues: { auto_enqueue: "always", detect_duplicates: false },
      }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "editSettings",
    );
    expect(mocks.updateAgentLink).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgentLink).toHaveBeenCalledWith({
      projectId: "project-1",
      agentId: "core:triager",
      patch: {
        config: { auto_enqueue: "always", detect_duplicates: false },
      },
    });
  });

  it("forwards an explicit null as patch.config: null (CLEAR)", async () => {
    await route.PATCH(jsonRequest("PATCH", { configValues: null }), params());

    expect(mocks.updateAgentLink).toHaveBeenCalledWith({
      projectId: "project-1",
      agentId: "core:triager",
      patch: { config: null },
    });
  });

  it("omits config from the patch when configValues is absent (untouched)", async () => {
    await route.PATCH(jsonRequest("PATCH", { enabled: false }), params());

    const call = mocks.updateAgentLink.mock.calls[0][0] as {
      patch: Record<string, unknown>;
    };

    expect(call.patch).toEqual({ enabled: false });
    expect(Object.prototype.hasOwnProperty.call(call.patch, "config")).toBe(
      false,
    );
  });

  it("rides the same body as the other aggregating fields", async () => {
    await route.PATCH(
      jsonRequest("PATCH", {
        enabled: true,
        branchBase: "develop",
        configValues: { intake_mode: "clarify" },
      }),
      params(),
    );

    expect(mocks.updateAgentLink).toHaveBeenCalledWith({
      projectId: "project-1",
      agentId: "core:triager",
      patch: {
        enabled: true,
        branchBase: "develop",
        config: { intake_mode: "clarify" },
      },
    });
  });

  it("rejects an unknown body field with 422 CONFIG before any write", async () => {
    const res = await route.PATCH(
      jsonRequest("PATCH", { configValues: {}, bogus: 1 }),
      params(),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");
    expect(mocks.updateAgentLink).not.toHaveBeenCalled();
  });

  it("rejects an empty PATCH body with 422 CONFIG", async () => {
    const res = await route.PATCH(jsonRequest("PATCH", {}), params());

    expect(res.status).toBe(422);
    expect(mocks.updateAgentLink).not.toHaveBeenCalled();
  });

  it("refuses a non-editor with 403 before any write", async () => {
    mocks.requireProjectAction.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "requires member"),
    );

    const res = await route.PATCH(
      jsonRequest("PATCH", { configValues: {} }),
      params(),
    );

    expect(res.status).toBe(403);
    expect(mocks.updateAgentLink).not.toHaveBeenCalled();
  });
});
