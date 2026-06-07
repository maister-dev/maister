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
const requireProjectRoleMock = vi.hoisted(() => vi.fn());
const requireProjectActionMock = vi.hoisted(() => vi.fn());
const getProjectBySlugMock = vi.hoisted(() => vi.fn());
const listProjectMembersMock = vi.hoisted(() => vi.fn());
const addProjectMemberMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/errors", () => ({
  MaisterError,
  isMaisterError: (err: unknown) => err instanceof MaisterError,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: requireActiveSessionMock,
  requireProjectRole: requireProjectRoleMock,
  requireProjectAction: requireProjectActionMock,
}));

vi.mock("@/lib/queries/project", () => ({
  getProjectBySlug: getProjectBySlugMock,
}));

vi.mock("@/lib/project-members", () => ({
  listProjectMembers: listProjectMembersMock,
  addProjectMember: addProjectMemberMock,
}));

function getRequest(slug: string): NextRequest {
  return new NextRequest(`http://localhost/api/projects/${slug}/members`);
}

function postRequest(slug: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/projects/${slug}/members`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("/api/projects/[slug]/members", () => {
  beforeEach(() => {
    vi.resetModules();
    requireActiveSessionMock.mockReset();
    requireProjectRoleMock.mockReset();
    requireProjectActionMock.mockReset();
    getProjectBySlugMock.mockReset();
    listProjectMembersMock.mockReset();
    addProjectMemberMock.mockReset();

    requireActiveSessionMock.mockResolvedValue({ id: "actor1" });
    getProjectBySlugMock.mockResolvedValue({ id: "prj1", archivedAt: null });
    requireProjectRoleMock.mockResolvedValue({
      user: { id: "actor1" },
      role: "viewer",
    });
    requireProjectActionMock.mockResolvedValue({
      user: { id: "actor1" },
      role: "admin",
    });
  });

  describe("GET", () => {
    it("returns 200 with members list", async () => {
      const member = {
        memberId: "m1",
        userId: "u1",
        email: "a@b.com",
        role: "member",
      };

      listProjectMembersMock.mockResolvedValue([member]);
      const { GET } = await import("../route");

      const res = await GET(getRequest("demo"), {
        params: Promise.resolve({ slug: "demo" }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.members).toEqual([member]);
      expect(requireProjectRoleMock).toHaveBeenCalledWith("prj1", "viewer");
      expect(listProjectMembersMock).toHaveBeenCalledWith("prj1");
    });

    it("returns 403 when requireProjectRole rejects with UNAUTHORIZED", async () => {
      requireProjectRoleMock.mockRejectedValueOnce(
        new MaisterError("UNAUTHORIZED", "Requires project role"),
      );
      const { GET } = await import("../route");

      const res = await GET(getRequest("demo"), {
        params: Promise.resolve({ slug: "demo" }),
      });
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.code).toBe("UNAUTHORIZED");
    });

    it("returns 409 when project is not found (getProjectBySlug returns null)", async () => {
      getProjectBySlugMock.mockResolvedValueOnce(null);
      const { GET } = await import("../route");

      const res = await GET(getRequest("missing"), {
        params: Promise.resolve({ slug: "missing" }),
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe("PRECONDITION");
    });

    it("returns 401 and never resolves the slug when unauthenticated", async () => {
      requireActiveSessionMock.mockRejectedValueOnce(
        new MaisterError("UNAUTHENTICATED", "Sign in required"),
      );
      const { GET } = await import("../route");

      const res = await GET(getRequest("demo"), {
        params: Promise.resolve({ slug: "demo" }),
      });
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.code).toBe("UNAUTHENTICATED");
      expect(getProjectBySlugMock).not.toHaveBeenCalled();
      expect(listProjectMembersMock).not.toHaveBeenCalled();
    });
  });

  describe("POST", () => {
    it("returns 201 with memberId and calls addProjectMember with correct args", async () => {
      addProjectMemberMock.mockResolvedValue({ memberId: "new-member-id" });
      const { POST } = await import("../route");

      const res = await POST(
        postRequest("demo", { userId: "user-x", role: "member" }),
        { params: Promise.resolve({ slug: "demo" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.memberId).toBe("new-member-id");
      expect(addProjectMemberMock).toHaveBeenCalledWith({
        projectId: "prj1",
        userId: "user-x",
        role: "member",
        actorId: "actor1",
      });
      expect(requireProjectActionMock).toHaveBeenCalledWith(
        "prj1",
        "manageMembers",
      );
    });

    it("returns 422 on invalid body (missing userId)", async () => {
      const { POST } = await import("../route");

      const res = await POST(postRequest("demo", { role: "member" }), {
        params: Promise.resolve({ slug: "demo" }),
      });
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.code).toBe("CONFIG");
      expect(addProjectMemberMock).not.toHaveBeenCalled();
    });

    it("returns 422 on invalid role value", async () => {
      const { POST } = await import("../route");

      const res = await POST(
        postRequest("demo", { userId: "user-x", role: "superadmin" }),
        { params: Promise.resolve({ slug: "demo" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body.code).toBe("CONFIG");
      expect(addProjectMemberMock).not.toHaveBeenCalled();
    });

    it("returns 409 when addProjectMember rejects with CONFLICT", async () => {
      addProjectMemberMock.mockRejectedValueOnce(
        new MaisterError("CONFLICT", "User is already a member"),
      );
      const { POST } = await import("../route");

      const res = await POST(
        postRequest("demo", { userId: "user-x", role: "member" }),
        { params: Promise.resolve({ slug: "demo" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe("CONFLICT");
    });

    it("returns 409 when project is not found (PRECONDITION)", async () => {
      getProjectBySlugMock.mockResolvedValueOnce(null);
      const { POST } = await import("../route");

      const res = await POST(
        postRequest("missing", { userId: "user-x", role: "member" }),
        { params: Promise.resolve({ slug: "missing" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe("PRECONDITION");
      expect(addProjectMemberMock).not.toHaveBeenCalled();
    });

    it("returns 401 and never resolves the slug when unauthenticated", async () => {
      requireActiveSessionMock.mockRejectedValueOnce(
        new MaisterError("UNAUTHENTICATED", "Sign in required"),
      );
      const { POST } = await import("../route");

      const res = await POST(
        postRequest("demo", { userId: "user-x", role: "member" }),
        { params: Promise.resolve({ slug: "demo" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.code).toBe("UNAUTHENTICATED");
      expect(getProjectBySlugMock).not.toHaveBeenCalled();
      expect(addProjectMemberMock).not.toHaveBeenCalled();
    });
  });
});
