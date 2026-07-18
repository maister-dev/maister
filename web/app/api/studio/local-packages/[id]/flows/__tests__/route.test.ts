import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors-core";

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

function malformedJsonReq(): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1/flows", {
      method: "POST",
      body: "{",
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
    const res = await POST(
      req({ sessionId: "editor-session", flow: FLOW }),
      ctx(),
    );

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

  it("rejects redundant cross-resource identifiers before loading the package", async () => {
    const res = await POST(
      req({
        sessionId: "editor-session",
        flow: FLOW,
        packageId: "another-package",
        projectId: "another-project",
      }),
      ctx(),
    );

    expect(res.status).toBe(422);
    expect(mocks.getLocalPackage).not.toHaveBeenCalled();
    expect(mocks.addFlowToLocalPackage).not.toHaveBeenCalled();
  });

  it("returns the RBAC refusal before reading package state", async () => {
    mocks.requireGlobalRole.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "member role required"),
    );

    const res = await POST(
      req({ sessionId: "editor-session", flow: FLOW }),
      ctx(),
    );

    expect(res.status).toBe(403);
    expect(mocks.getLocalPackage).not.toHaveBeenCalled();
    expect(mocks.addFlowToLocalPackage).not.toHaveBeenCalled();
  });

  it("returns the edit-lock conflict without converting it to a route crash", async () => {
    mocks.addFlowToLocalPackage.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "editor lock is not held"),
    );

    const res = await POST(
      req({ sessionId: "editor-session", flow: FLOW }),
      ctx(),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "CONFLICT" });
  });

  it("returns the safe duplicate-ID reason for the localized Flow wizard", async () => {
    mocks.addFlowToLocalPackage.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "Flow ID already exists", {
        details: { reason: "duplicate_flow_id" },
      }),
    );

    const res = await POST(
      req({ sessionId: "editor-session", flow: FLOW }),
      ctx(),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      code: "CONFLICT",
      message: "Flow ID already exists",
      details: { reason: "duplicate_flow_id" },
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

  it("returns 422 for malformed JSON before the edit-lock operation", async () => {
    const res = await POST(malformedJsonReq(), ctx());

    expect(res.status).toBe(422);
    expect(mocks.addFlowToLocalPackage).not.toHaveBeenCalled();
  });
});
