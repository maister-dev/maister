import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireGlobalRole: vi.fn(),
  createLocalPackageWithFlow: vi.fn(),
  listLocalPackages: vi.fn(),
  toLocalPackageDto: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireGlobalRole: mocks.requireGlobalRole,
}));
vi.mock("@/lib/local-packages/service", () => ({
  createLocalPackageWithFlow: mocks.createLocalPackageWithFlow,
  listLocalPackages: mocks.listLocalPackages,
  toLocalPackageDto: mocks.toLocalPackageDto,
}));

import { POST } from "../route";

const FLOW = {
  id: "bugfix",
  metadata: {
    title: "Bug fix",
    summary: "Repair a confirmed defect.",
    route_when: "A report has reproduction steps.",
  },
};

function req(body: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function malformedJsonReq(): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireGlobalRole.mockResolvedValue({ id: "u1", role: "member" });
  mocks.createLocalPackageWithFlow.mockResolvedValue({
    package: { id: "lp1", name: "Fixes" },
    flowPath: "flows/bugfix/flow.yaml",
  });
  mocks.toLocalPackageDto.mockReturnValue({ id: "lp1", name: "Fixes" });
});

describe("POST /api/studio/local-packages", () => {
  it("creates the package and required first Flow in the one canonical request", async () => {
    const res = await POST(req({ name: "Fixes", flow: FLOW }));

    expect(res.status).toBe(201);
    expect(mocks.createLocalPackageWithFlow).toHaveBeenCalledWith({
      name: "Fixes",
      createdBy: "u1",
      flow: FLOW,
    });
    await expect(res.json()).resolves.toEqual({
      localPackage: { id: "lp1", name: "Fixes" },
      createdFlow: { id: "bugfix", path: "flows/bugfix/flow.yaml" },
    });
  });

  it("rejects the former empty-package body before any create operation", async () => {
    const res = await POST(req({ name: "Fixes" }));

    expect(res.status).toBe(422);
    expect(mocks.createLocalPackageWithFlow).not.toHaveBeenCalled();
  });

  it("returns 422 for malformed JSON before any create operation", async () => {
    const res = await POST(malformedJsonReq());

    expect(res.status).toBe(422);
    expect(mocks.createLocalPackageWithFlow).not.toHaveBeenCalled();
  });
});
