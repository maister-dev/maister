import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist MaisterError so instanceof checks survive vi.resetModules().
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

const requireActiveSessionMock = vi.hoisted(() => vi.fn());
const requireProjectActionMock = vi.hoisted(() => vi.fn());
const getProjectBySlugMock = vi.hoisted(() => vi.fn());
const changeProjectMemberRoleMock = vi.hoisted(() => vi.fn());
const removeProjectMemberMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/errors", () => ({
  MaisterError,
  isMaisterError: (err: unknown) => err instanceof MaisterError,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: requireActiveSessionMock,
  requireProjectAction: requireProjectActionMock,
}));

vi.mock("@/lib/queries/project", () => ({
  getProjectBySlug: getProjectBySlugMock,
}));

vi.mock("@/lib/project-members", () => ({
  changeProjectMemberRole: changeProjectMemberRoleMock,
  removeProjectMember: removeProjectMemberMock,
}));

function patchRequest(
  slug: string,
  memberId: string,
  body: unknown,
): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${slug}/members/${memberId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
}

function deleteRequest(
  slug: string,
  memberId: string,
  expectedRole: string | null = "member",
): NextRequest {
  const query = expectedRole === null ? "" : `?expectedRole=${expectedRole}`;

  return new NextRequest(
    `http://localhost/api/projects/${slug}/members/${memberId}${query}`,
    { method: "DELETE" },
  );
}

describe("/api/projects/[slug]/members/[memberId]", () => {
  beforeEach(() => {
    vi.resetModules();
    requireActiveSessionMock.mockReset();
    requireProjectActionMock.mockReset();
    getProjectBySlugMock.mockReset();
    changeProjectMemberRoleMock.mockReset();
    removeProjectMemberMock.mockReset();

    requireActiveSessionMock.mockResolvedValue({ id: "actor1" });
    getProjectBySlugMock.mockResolvedValue({ id: "prj1", archivedAt: null });
    requireProjectActionMock.mockResolvedValue({
      user: { id: "actor1" },
      role: "admin",
    });
  });

  describe("PATCH", () => {
    it("returns 200 and calls changeProjectMemberRole with correct args", async () => {
      changeProjectMemberRoleMock.mockResolvedValue(undefined);
      const { PATCH } = await import("../route");

      const res = await PATCH(
        patchRequest("demo", "mem-1", {
          role: "admin",
          expectedRole: "member",
        }),
        { params: Promise.resolve({ slug: "demo", memberId: "mem-1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(changeProjectMemberRoleMock).toHaveBeenCalledWith({
        projectId: "prj1",
        memberId: "mem-1",
        role: "admin",
        expectedRole: "member",
        actorId: "actor1",
      });
      expect(requireProjectActionMock).toHaveBeenCalledWith(
        "prj1",
        "manageMembers",
      );
    });

    it("returns 422 on invalid role value", async () => {
      const { PATCH } = await import("../route");

      const res = await PATCH(
        patchRequest("demo", "mem-1", {
          role: "superadmin",
          expectedRole: "member",
        }),
        { params: Promise.resolve({ slug: "demo", memberId: "mem-1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.code).toBe("CONFIG");
      expect(changeProjectMemberRoleMock).not.toHaveBeenCalled();
    });

    it("returns 422 on missing expectedRole field", async () => {
      const { PATCH } = await import("../route");

      const res = await PATCH(
        patchRequest("demo", "mem-1", { role: "admin" }),
        {
          params: Promise.resolve({ slug: "demo", memberId: "mem-1" }),
        },
      );
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.code).toBe("CONFIG");
      expect(changeProjectMemberRoleMock).not.toHaveBeenCalled();
    });

    it("returns 409 CONFLICT on a stale role change", async () => {
      changeProjectMemberRoleMock.mockRejectedValueOnce(
        new MaisterError(
          "CONFLICT",
          "Member not found or changed concurrently",
        ),
      );
      const { PATCH } = await import("../route");

      const res = await PATCH(
        patchRequest("demo", "mem-1", {
          role: "viewer",
          expectedRole: "member",
        }),
        { params: Promise.resolve({ slug: "demo", memberId: "mem-1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe("CONFLICT");
    });

    it("returns 401 and never resolves the slug when unauthenticated", async () => {
      requireActiveSessionMock.mockRejectedValueOnce(
        new MaisterError("UNAUTHENTICATED", "Sign in required"),
      );
      const { PATCH } = await import("../route");

      const res = await PATCH(
        patchRequest("demo", "mem-1", {
          role: "admin",
          expectedRole: "member",
        }),
        { params: Promise.resolve({ slug: "demo", memberId: "mem-1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.code).toBe("UNAUTHENTICATED");
      expect(getProjectBySlugMock).not.toHaveBeenCalled();
      expect(changeProjectMemberRoleMock).not.toHaveBeenCalled();
    });

    it("returns 403 when requireProjectAction rejects UNAUTHORIZED", async () => {
      requireProjectActionMock.mockRejectedValueOnce(
        new MaisterError("UNAUTHORIZED", "Requires manageMembers"),
      );
      const { PATCH } = await import("../route");

      const res = await PATCH(
        patchRequest("demo", "mem-1", {
          role: "member",
          expectedRole: "admin",
        }),
        { params: Promise.resolve({ slug: "demo", memberId: "mem-1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.code).toBe("UNAUTHORIZED");
      expect(changeProjectMemberRoleMock).not.toHaveBeenCalled();
    });
  });

  describe("DELETE", () => {
    it("returns 200 and calls removeProjectMember with correct args", async () => {
      removeProjectMemberMock.mockResolvedValue(undefined);
      const { DELETE } = await import("../route");

      const res = await DELETE(deleteRequest("demo", "mem-1", "member"), {
        params: Promise.resolve({ slug: "demo", memberId: "mem-1" }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(removeProjectMemberMock).toHaveBeenCalledWith({
        projectId: "prj1",
        memberId: "mem-1",
        expectedRole: "member",
        actorId: "actor1",
      });
      expect(requireProjectActionMock).toHaveBeenCalledWith(
        "prj1",
        "manageMembers",
      );
    });

    it("returns 422 when expectedRole query param is missing", async () => {
      const { DELETE } = await import("../route");

      const res = await DELETE(deleteRequest("demo", "mem-1", null), {
        params: Promise.resolve({ slug: "demo", memberId: "mem-1" }),
      });
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.code).toBe("CONFIG");
      expect(removeProjectMemberMock).not.toHaveBeenCalled();
    });

    it("returns 409 when removeProjectMember rejects CONFLICT", async () => {
      removeProjectMemberMock.mockRejectedValueOnce(
        new MaisterError(
          "CONFLICT",
          "Member not found or changed concurrently",
        ),
      );
      const { DELETE } = await import("../route");

      const res = await DELETE(deleteRequest("demo", "mem-1", "member"), {
        params: Promise.resolve({ slug: "demo", memberId: "mem-1" }),
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe("CONFLICT");
    });

    it("returns 401 and never resolves the slug when unauthenticated", async () => {
      requireActiveSessionMock.mockRejectedValueOnce(
        new MaisterError("UNAUTHENTICATED", "Sign in required"),
      );
      const { DELETE } = await import("../route");

      const res = await DELETE(deleteRequest("demo", "mem-1", "member"), {
        params: Promise.resolve({ slug: "demo", memberId: "mem-1" }),
      });
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.code).toBe("UNAUTHENTICATED");
      expect(getProjectBySlugMock).not.toHaveBeenCalled();
      expect(removeProjectMemberMock).not.toHaveBeenCalled();
    });

    it("returns 403 when requireProjectAction rejects UNAUTHORIZED", async () => {
      requireProjectActionMock.mockRejectedValueOnce(
        new MaisterError("UNAUTHORIZED", "Requires manageMembers"),
      );
      const { DELETE } = await import("../route");

      const res = await DELETE(deleteRequest("demo", "mem-1", "member"), {
        params: Promise.resolve({ slug: "demo", memberId: "mem-1" }),
      });
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.code).toBe("UNAUTHORIZED");
      expect(removeProjectMemberMock).not.toHaveBeenCalled();
    });
  });
});
