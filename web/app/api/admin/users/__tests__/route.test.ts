import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireGlobalRoleMock = vi.hoisted(() => vi.fn());
const createAdminUserMock = vi.hoisted(() => vi.fn());

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
  createAdminUser: createAdminUserMock,
}));
vi.mock("@/lib/errors", () => ({
  MaisterError,
  isMaisterError: (err: unknown) => err instanceof MaisterError,
}));

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/users", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("/api/admin/users POST", () => {
  beforeEach(() => {
    vi.resetModules();
    requireGlobalRoleMock.mockReset();
    requireGlobalRoleMock.mockResolvedValue({ id: "admin-1", role: "admin" });
    createAdminUserMock.mockReset();
  });

  it("returns 201 with id and tempPassword on valid body", async () => {
    createAdminUserMock.mockResolvedValue({
      id: "user-42",
      tempPassword: "supersecret123!",
    });
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({
        name: "Alice",
        email: "alice@example.com",
        role: "member",
        status: "active",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ id: "user-42", tempPassword: "supersecret123!" });
    expect(createAdminUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: "admin-1",
        name: "Alice",
        email: "alice@example.com",
        role: "member",
        status: "active",
      }),
    );
  });

  it("returns 422 on invalid body (missing email)", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({ name: "Bob", role: "viewer", status: "pending" }),
    );

    expect(response.status).toBe(422);
    expect(createAdminUserMock).not.toHaveBeenCalled();
  });

  it("returns 403 when requireGlobalRole rejects UNAUTHORIZED", async () => {
    requireGlobalRoleMock.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "not an admin"),
    );
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({
        name: "Charlie",
        email: "charlie@example.com",
        role: "viewer",
        status: "active",
      }),
    );

    expect(response.status).toBe(403);
    expect(createAdminUserMock).not.toHaveBeenCalled();
  });

  it("returns 409 when createAdminUser rejects CONFLICT", async () => {
    createAdminUserMock.mockRejectedValue(
      new MaisterError("CONFLICT", "User already exists: alice@example.com"),
    );
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({
        name: "Alice",
        email: "alice@example.com",
        role: "member",
        status: "active",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
  });
});
