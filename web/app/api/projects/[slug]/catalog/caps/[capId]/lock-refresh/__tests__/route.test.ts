import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeCatalogRouteProject: vi.fn(),
  isLockableCapability: vi.fn(),
  acquireLock: vi.fn(),
  refreshLock: vi.fn(),
}));

vi.mock("@/lib/catalog/route-auth", () => ({
  authorizeCatalogRouteProject: mocks.authorizeCatalogRouteProject,
}));
vi.mock("@/lib/catalog/authored-lock", () => ({
  isLockableCapability: mocks.isLockableCapability,
  acquireLock: mocks.acquireLock,
  refreshLock: mocks.refreshLock,
}));

import { POST } from "../route";

import { MaisterError } from "@/lib/errors";

function req(body: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/projects/demo/catalog/caps/cap-1/lock-refresh", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function ctx() {
  return { params: Promise.resolve({ slug: "demo", capId: "cap-1" }) };
}

const lockState = {
  held: true,
  heldByMe: true,
  holderLabel: null,
  expiresAt: new Date("2026-07-21T00:30:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeCatalogRouteProject.mockResolvedValue({
    projectId: "project-demo",
    userId: "u1",
  });
  mocks.isLockableCapability.mockResolvedValue(true);
  mocks.acquireLock.mockResolvedValue(lockState);
  mocks.refreshLock.mockResolvedValue(lockState);
});

describe("POST /api/projects/[slug]/catalog/caps/[capId]/lock-refresh", () => {
  it("defaults to acquire mode using url-derived identifiers", async () => {
    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(200);
    expect(mocks.authorizeCatalogRouteProject).toHaveBeenCalledWith("demo");
    expect(mocks.acquireLock).toHaveBeenCalledWith("cap-1", "u1", "s1");
    expect(mocks.refreshLock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ held: true, heldByMe: true });
  });

  it("uses refresh-only mode for heartbeats", async () => {
    const res = await POST(req({ sessionId: "s1", mode: "refresh" }), ctx());

    expect(res.status).toBe(200);
    expect(mocks.refreshLock).toHaveBeenCalledWith("cap-1", "s1");
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller lacks manageCatalog", async () => {
    mocks.authorizeCatalogRouteProject.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "forbidden"),
    );

    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(403);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing, foreign-project, or ARCHIVED capability", async () => {
    mocks.isLockableCapability.mockResolvedValue(false);

    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(404);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
    expect(mocks.refreshLock).not.toHaveBeenCalled();
  });

  it("returns 422 for a missing sessionId", async () => {
    const res = await POST(req({}), ctx());

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("returns 409 when a heartbeat refresh lost the lock", async () => {
    mocks.refreshLock.mockRejectedValue(
      new MaisterError("CONFLICT", "edit-lock expired", {
        details: { reason: "edit_lock_not_held" },
      }),
    );

    const res = await POST(req({ sessionId: "s1", mode: "refresh" }), ctx());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
  });
});
