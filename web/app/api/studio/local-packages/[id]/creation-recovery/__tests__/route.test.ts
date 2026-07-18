import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  assertUserHoldsLock: vi.fn(),
  getLocalPackage: vi.fn(),
  recoverLocalPackageCreation: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({ requireGlobalRole: mocks.requireGlobalRole }));
vi.mock("@/lib/local-packages/lock", () => ({
  assertUserHoldsLock: mocks.assertUserHoldsLock,
}));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
  recoverLocalPackageCreation: mocks.recoverLocalPackageCreation,
}));

import { POST } from "../route";

function req(body?: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1/creation-recovery", {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }),
  );
}

function ctx() {
  return { params: Promise.resolve({ id: "lp1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireGlobalRole.mockResolvedValue({ id: "u1", role: "member" });
  mocks.getLocalPackage.mockResolvedValue({
    id: "lp1",
    status: "active",
    createdBy: "u1",
    creationState: { kind: "add_flow", flow: { id: "second" } },
  });
  mocks.recoverLocalPackageCreation.mockResolvedValue({
    recoveryStatus: "ready",
    flowPath: "flows/second/flow.yaml",
  });
});

describe("POST /api/studio/local-packages/{id}/creation-recovery", () => {
  it("rejects a body so recovery cannot accept a repair payload or redundant id", async () => {
    const res = await POST(req({ packageId: "other" }), ctx());

    expect(res.status).toBe(422);
    expect(mocks.getLocalPackage).not.toHaveBeenCalled();
    expect(mocks.recoverLocalPackageCreation).not.toHaveBeenCalled();
  });

  it("requires the current editor user to hold a live lock for add-flow recovery", async () => {
    const res = await POST(req(), ctx());

    expect(res.status).toBe(200);
    expect(mocks.assertUserHoldsLock).toHaveBeenCalledWith("lp1", "u1");
    expect(mocks.recoverLocalPackageCreation).toHaveBeenCalledWith("lp1");
    await expect(res.json()).resolves.toEqual({ recoveryStatus: "ready" });
  });

  it("returns the live-lock refusal without attempting recovery", async () => {
    mocks.assertUserHoldsLock.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "edit-lock not held"),
    );

    const res = await POST(req(), ctx());

    expect(res.status).toBe(409);
    expect(mocks.recoverLocalPackageCreation).not.toHaveBeenCalled();
  });

  it("documents and returns a malformed private-journal failure as CONFIG 400", async () => {
    mocks.recoverLocalPackageCreation.mockRejectedValueOnce(
      new MaisterError(
        "CONFIG",
        "local package creation recovery journal is invalid",
      ),
    );

    const res = await POST(req(), ctx());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "CONFIG" });
  });

  it("does not let another member recover a first-Flow operation", async () => {
    mocks.getLocalPackage.mockResolvedValueOnce({
      id: "lp1",
      status: "active",
      createdBy: "owner",
      creationState: {
        kind: "create_package_with_flow",
        flow: { id: "first" },
      },
    });

    const res = await POST(req(), ctx());

    expect(res.status).toBe(403);
    expect(mocks.recoverLocalPackageCreation).not.toHaveBeenCalled();
  });
});
