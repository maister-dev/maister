import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-129 §d: the three sync routes are thin — member-gated, strict bodies
// carrying the edit-lock sessionId (commit-route idiom), 404 pre-check, and
// typed-error mapping (CONFLICT→409, PRECONDITION→409, CONFIG→422). The
// precondition MATRIX itself is proven on real PG+git in
// sync.integration.test.ts — here we pin the contract shell.
const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  getLocalPackage: vi.fn(),
  syncFromUpstream: vi.fn(),
  resolveSync: vi.fn(),
  abortSync: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: mocks.requireGlobalRole,
}));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
}));
vi.mock("@/lib/local-packages/sync", () => ({
  syncFromUpstream: mocks.syncFromUpstream,
  resolveSync: mocks.resolveSync,
  abortSync: mocks.abortSync,
}));

import { POST as syncPOST } from "../route";
import { POST as resolvePOST } from "../resolve/route";
import { POST as abortPOST } from "../abort/route";

import { MaisterError } from "@/lib/errors";

function req(body?: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1/sync", {
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

const RESULT = {
  outcome: "clean",
  conflictedFiles: [],
  targetInstallId: "inst-2",
  targetRef: "local-bbb",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireGlobalRole.mockResolvedValue({ id: "u1", role: "member" });
  mocks.getLocalPackage.mockResolvedValue({ id: "lp1", status: "active" });
  mocks.syncFromUpstream.mockResolvedValue(RESULT);
  mocks.resolveSync.mockResolvedValue({ ...RESULT, outcome: "completed" });
  mocks.abortSync.mockResolvedValue(undefined);
});

describe("sync routes contract shell", () => {
  it("POST /sync forwards {sessionId, targetInstallId} and returns the lib DTO", async () => {
    const res = await syncPOST(
      req({ sessionId: "s1", targetInstallId: "inst-2" }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mocks.syncFromUpstream).toHaveBeenCalledWith({
      localPackageId: "lp1",
      targetInstallId: "inst-2",
      sessionId: "s1",
    });
    expect(await res.json()).toEqual(RESULT);
  });

  it("POST /sync without sessionId → 422, lib never reached (amended contract)", async () => {
    const res = await syncPOST(req({ targetInstallId: "inst-2" }), ctx());

    expect(res.status).toBe(422);
    expect(mocks.syncFromUpstream).not.toHaveBeenCalled();
  });

  it("maps a lib CONFLICT (sync in progress / bad target) to 409", async () => {
    mocks.syncFromUpstream.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "sync in progress"),
    );

    const res = await syncPOST(
      req({ sessionId: "s1", targetInstallId: "inst-2" }),
      ctx(),
    );

    expect(res.status).toBe(409);
  });

  it("maps the lineage CONFIG degradation to 422", async () => {
    mocks.syncFromUpstream.mockRejectedValueOnce(
      new MaisterError("CONFIG", "source install unavailable"),
    );

    const res = await syncPOST(
      req({ sessionId: "s1", targetInstallId: "inst-2" }),
      ctx(),
    );

    expect(res.status).toBe(422);
  });

  it("404s an unknown package on all three routes", async () => {
    mocks.getLocalPackage.mockResolvedValue(null);

    expect(
      (
        await syncPOST(
          req({ sessionId: "s1", targetInstallId: "inst-2" }),
          ctx(),
        )
      ).status,
    ).toBe(404);
    expect((await resolvePOST(req({ sessionId: "s1" }), ctx())).status).toBe(
      404,
    );
    expect((await abortPOST(req({ sessionId: "s1" }), ctx())).status).toBe(404);
    expect(mocks.syncFromUpstream).not.toHaveBeenCalled();
    expect(mocks.resolveSync).not.toHaveBeenCalled();
    expect(mocks.abortSync).not.toHaveBeenCalled();
  });

  it("POST /sync/resolve forwards the optional commitMessage", async () => {
    const res = await resolvePOST(
      req({ sessionId: "s1", commitMessage: "resolved by hand" }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mocks.resolveSync).toHaveBeenCalledWith({
      localPackageId: "lp1",
      sessionId: "s1",
      commitMessage: "resolved by hand",
    });
  });

  it("POST /sync/abort requires a pending sync — lib CONFLICT → 409", async () => {
    mocks.abortSync.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "no sync in progress"),
    );

    const res = await abortPOST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(409);
  });
});
