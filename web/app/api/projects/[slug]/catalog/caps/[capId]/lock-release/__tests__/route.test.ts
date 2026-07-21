import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeCatalogRouteProject: vi.fn(),
  isLockableCapability: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock("@/lib/catalog/route-auth", () => ({
  authorizeCatalogRouteProject: mocks.authorizeCatalogRouteProject,
}));
vi.mock("@/lib/catalog/authored-lock", () => ({
  isLockableCapability: mocks.isLockableCapability,
  releaseLock: mocks.releaseLock,
}));

import { POST } from "../route";

import { MaisterError } from "@/lib/errors";

function req(body: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/projects/demo/catalog/caps/cap-1/lock-release", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function ctx() {
  return { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeCatalogRouteProject.mockResolvedValue({
    projectId: "project-demo",
    userId: "u1",
  });
  mocks.isLockableCapability.mockResolvedValue(true);
  mocks.releaseLock.mockResolvedValue(undefined);
});

describe("POST /api/projects/[slug]/catalog/caps/[capId]/lock-release", () => {
  it("releases the lock for the caller's session", async () => {
    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(200);
    expect(mocks.authorizeCatalogRouteProject).toHaveBeenCalledWith("demo");
    expect(mocks.releaseLock).toHaveBeenCalledWith("cap-1", "s1");
    expect(await res.json()).toEqual({ released: true });
  });

  it("returns 422 for a missing sessionId", async () => {
    const res = await POST(req({}), ctx());

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks manageCatalog", async () => {
    mocks.authorizeCatalogRouteProject.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "forbidden"),
    );

    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(403);
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing, foreign-project, or ARCHIVED capability", async () => {
    mocks.isLockableCapability.mockResolvedValue(false);

    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(404);
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });
});
