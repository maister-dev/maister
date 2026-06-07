import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireGlobalRoleMock = vi.hoisted(() => vi.fn());
const updateAdminUserMock = vi.hoisted(() => vi.fn());
const hardDeleteAdminUserMock = vi.hoisted(() => vi.fn());

// Stable MaisterError class shared between test mocks and the route module.
const { MaisterError } = vi.hoisted(() => {
  class MaisterError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = "MaisterError";
      this.code = code;
      Object.setPrototypeOf(this, MaisterError.prototype);
    }
  }

  return { MaisterError };
});

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: requireGlobalRoleMock,
}));
vi.mock("@/lib/users", () => ({
  updateAdminUser: updateAdminUserMock,
  hardDeleteAdminUser: hardDeleteAdminUserMock,
}));
vi.mock("@/lib/errors", () => ({
  MaisterError,
  isMaisterError: (err: unknown) => err instanceof MaisterError,
}));

const USER_ID = "user-99";

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/users/${USER_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function deleteRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/admin/users/${USER_ID}`, {
    method: "DELETE",
  });
}

function makeParams(userId: string = USER_ID) {
  return { params: Promise.resolve({ userId }) };
}

describe("/api/admin/users/[userId]", () => {
  beforeEach(() => {
    vi.resetModules();
    requireGlobalRoleMock.mockReset();
    requireGlobalRoleMock.mockResolvedValue({ id: "admin-1", role: "admin" });
    updateAdminUserMock.mockReset();
    updateAdminUserMock.mockResolvedValue(undefined);
    hardDeleteAdminUserMock.mockReset();
    hardDeleteAdminUserMock.mockResolvedValue(undefined);
  });

  describe("PATCH", () => {
    it("returns 200 and calls updateAdminUser with name and email", async () => {
      const { PATCH } = await import("../route");

      const response = await PATCH(
        patchRequest({ name: "New Name", email: "new@example.com" }),
        makeParams(),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(updateAdminUserMock).toHaveBeenCalledWith(
        expect.objectContaining({
          adminUserId: "admin-1",
          targetUserId: USER_ID,
          name: "New Name",
          email: "new@example.com",
        }),
      );
    });

    it("returns 422 on empty body (no fields to update)", async () => {
      const { PATCH } = await import("../route");

      const response = await PATCH(patchRequest({}), makeParams());

      expect(response.status).toBe(422);
      expect(updateAdminUserMock).not.toHaveBeenCalled();
    });

    it("returns 403 when requireGlobalRole rejects UNAUTHORIZED", async () => {
      requireGlobalRoleMock.mockRejectedValue(
        new MaisterError("UNAUTHORIZED", "not an admin"),
      );
      const { PATCH } = await import("../route");

      const response = await PATCH(
        patchRequest({ role: "viewer" }),
        makeParams(),
      );

      expect(response.status).toBe(403);
      expect(updateAdminUserMock).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("returns 200 and calls hardDeleteAdminUser", async () => {
      const { DELETE } = await import("../route");

      const response = await DELETE(deleteRequest(), makeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(hardDeleteAdminUserMock).toHaveBeenCalledWith({
        adminUserId: "admin-1",
        targetUserId: USER_ID,
      });
    });

    it("returns 409 when hardDeleteAdminUser rejects PRECONDITION", async () => {
      hardDeleteAdminUserMock.mockRejectedValue(
        new MaisterError(
          "PRECONDITION",
          "Only unused pending accounts can be hard-deleted; disable instead",
        ),
      );
      const { DELETE } = await import("../route");

      const response = await DELETE(deleteRequest(), makeParams());
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.code).toBe("PRECONDITION");
    });

    it("returns 403 when requireGlobalRole rejects UNAUTHORIZED", async () => {
      requireGlobalRoleMock.mockRejectedValue(
        new MaisterError("UNAUTHORIZED", "not an admin"),
      );
      const { DELETE } = await import("../route");

      const response = await DELETE(deleteRequest(), makeParams());

      expect(response.status).toBe(403);
      expect(hardDeleteAdminUserMock).not.toHaveBeenCalled();
    });
  });
});
