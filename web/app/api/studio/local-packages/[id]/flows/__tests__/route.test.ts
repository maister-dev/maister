import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  getLocalPackage: vi.fn(),
  addFlowToLocalPackage: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({ requireGlobalRole: mocks.requireGlobalRole }));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
  addFlowToLocalPackage: mocks.addFlowToLocalPackage,
}));

import { POST } from "../route";

const FLOW = {
  id: "second",
  metadata: {
    title: "Second Flow",
    summary: "A second launchable Flow.",
    route_when: "Another route is needed.",
  },
};

function req(body: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1/flows", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function ctx() {
  return { params: Promise.resolve({ id: "lp1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireGlobalRole.mockResolvedValue({ id: "u1", role: "member" });
  mocks.getLocalPackage.mockResolvedValue({ id: "lp1", status: "active" });
  mocks.addFlowToLocalPackage.mockResolvedValue({
    package: { id: "lp1" },
    flowPath: "flows/second/flow.yaml",
  });
});

describe("POST /api/studio/local-packages/{id}/flows", () => {
  it("uses the URL package id and the lock token, never a body package id", async () => {
    const res = await POST(req({ sessionId: "editor-session", flow: FLOW }), ctx());

    expect(res.status).toBe(201);
    expect(mocks.addFlowToLocalPackage).toHaveBeenCalledWith({
      packageId: "lp1",
      sessionId: "editor-session",
      flow: FLOW,
    });
    await expect(res.json()).resolves.toEqual({
      createdFlow: { id: "second", path: "flows/second/flow.yaml" },
    });
  });

  it("rejects an unsafe Flow ID before the edit-lock operation", async () => {
    const res = await POST(
      req({ sessionId: "editor-session", flow: { ...FLOW, id: "../escape" } }),
      ctx(),
    );

    expect(res.status).toBe(422);
    expect(mocks.addFlowToLocalPackage).not.toHaveBeenCalled();
  });
});
