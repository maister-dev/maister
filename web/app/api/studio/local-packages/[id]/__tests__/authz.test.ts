import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// (ADR-095/096) Local-package Studio routes must gate MUTATIONS at member level
// (requireGlobalRole — blocks disabled / forced-password-change / viewer) and
// READS at requireActiveSession. The cited finding: PATCH/DELETE previously used
// requireSession, which admits a disabled or must-change session. These pin the
// gate per verb so a revert to requireSession fails CI.
const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireGlobalRole: vi.fn(),
  getLocalPackage: vi.fn(),
  renameLocalPackage: vi.fn(),
  setLocalPackageStatus: vi.fn(),
  deleteLocalPackage: vi.fn(),
  listFiles: vi.fn(),
  readLockState: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireGlobalRole: mocks.requireGlobalRole,
}));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
  renameLocalPackage: mocks.renameLocalPackage,
  setLocalPackageStatus: mocks.setLocalPackageStatus,
  deleteLocalPackage: mocks.deleteLocalPackage,
  listFiles: mocks.listFiles,
  toLocalPackageDto: (row: unknown) => row,
}));
vi.mock("@/lib/local-packages/lock", () => ({
  readLockState: mocks.readLockState,
}));

import { DELETE, GET, PATCH } from "../route";

import { MaisterError } from "@/lib/errors";

const activePkg = { id: "lp1", status: "active", name: "demo" };

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1?session=s1", {
      method,
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

const DENY_CODES = [
  "ACCOUNT_INACTIVE",
  "PASSWORD_CHANGE_REQUIRED",
  "UNAUTHORIZED",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSession.mockResolvedValue({ id: "u1", role: "member" });
  mocks.requireGlobalRole.mockResolvedValue({ id: "u1", role: "member" });
  mocks.getLocalPackage.mockResolvedValue(activePkg);
  mocks.renameLocalPackage.mockResolvedValue({ ...activePkg, name: "renamed" });
  mocks.setLocalPackageStatus.mockResolvedValue({
    ...activePkg,
    status: "archived",
  });
  mocks.deleteLocalPackage.mockResolvedValue(undefined);
  mocks.listFiles.mockResolvedValue([]);
  mocks.readLockState.mockResolvedValue({
    held: false,
    heldByMe: false,
    holderLabel: null,
    expiresAt: null,
  });
});

describe("studio/local-packages/[id] authz", () => {
  it("GET reads with an active session, no role gate", async () => {
    const res = await GET(req("GET"), ctx());

    expect(res.status).toBe(200);
    expect(mocks.requireActiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.requireGlobalRole).not.toHaveBeenCalled();
  });

  it("PATCH is gated by requireGlobalRole(member)", async () => {
    const res = await PATCH(req("PATCH", { name: "renamed" }), ctx());

    expect(res.status).toBe(200);
    expect(mocks.requireGlobalRole).toHaveBeenCalledWith("member");
    expect(mocks.renameLocalPackage).toHaveBeenCalled();
  });

  it("DELETE is gated by requireGlobalRole(member)", async () => {
    const res = await DELETE(req("DELETE"), ctx());

    expect(res.status).toBe(204);
    expect(mocks.requireGlobalRole).toHaveBeenCalledWith("member");
    expect(mocks.deleteLocalPackage).toHaveBeenCalledWith("lp1");
  });

  for (const code of DENY_CODES) {
    it(`PATCH denies a ${code} session 403 without mutating`, async () => {
      mocks.requireGlobalRole.mockRejectedValueOnce(
        new MaisterError(code, "denied"),
      );

      const res = await PATCH(req("PATCH", { name: "renamed" }), ctx());

      expect(res.status).toBe(403);
      expect(mocks.renameLocalPackage).not.toHaveBeenCalled();
      expect(mocks.setLocalPackageStatus).not.toHaveBeenCalled();
    });

    it(`DELETE denies a ${code} session 403 without mutating`, async () => {
      mocks.requireGlobalRole.mockRejectedValueOnce(
        new MaisterError(code, "denied"),
      );

      const res = await DELETE(req("DELETE"), ctx());

      expect(res.status).toBe(403);
      expect(mocks.deleteLocalPackage).not.toHaveBeenCalled();
    });
  }
});
