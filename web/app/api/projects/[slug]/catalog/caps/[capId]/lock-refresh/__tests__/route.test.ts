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
    expect(mocks.refreshLock).toHaveBeenCalledWith("cap-1", "s1", "u1");
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
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    // (ADR-149) The reason MUST survive serialization: a stale-CAS refusal is
    // also 409 CONFLICT, so `details.reason` is the only thing that separates
    // them without matching on message text. Asserting `code` alone let the
    // catalog serializer silently drop `details` for the whole caps family.
    expect(body.details).toEqual({ reason: "edit_lock_not_held" });
  });

  it("scopes the lookup to the SERVER-resolved projectId, not the url slug", async () => {
    await POST(req({ sessionId: "s1" }), ctx());

    // Passing `slug` here instead of the authorized projectId would let a
    // capability from another project be locked; nothing else in this suite
    // observes that argument.
    expect(mocks.isLockableCapability).toHaveBeenCalledWith(
      "project-demo",
      "cap-1",
    );
  });

  it("reports a foreign live lock as 200 heldByMe=false, never 409", async () => {
    mocks.acquireLock.mockResolvedValue({
      held: true,
      heldByMe: false,
      holderLabel: "Ada Lovelace",
      expiresAt: new Date("2026-07-21T00:30:00.000Z"),
    });

    const res = await POST(req({ sessionId: "s2" }), ctx());

    // The route's central design decision: a foreign lock is a STATE the editor
    // renders read-only, not an error. A 409 here would break that contract.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      held: true,
      heldByMe: false,
      holderLabel: "Ada Lovelace",
    });
  });

  it("returns 401 for an unauthenticated caller", async () => {
    mocks.authorizeCatalogRouteProject.mockRejectedValue(
      new MaisterError("UNAUTHENTICATED", "sign in"),
    );

    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(401);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("rejects unknown body keys (schema is strict)", async () => {
    const res = await POST(
      req({ sessionId: "s1", capId: "cap-evil", projectId: "other" }),
      ctx(),
    );

    // `.strict()` is what keeps `sessionId` an opaque bearer token rather than
    // a body-controlled locator; a permissive schema would silently accept
    // caller-supplied identifiers alongside it.
    expect(res.status).toBe(422);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body as 422, not 500", async () => {
    const res = await POST(req("{not json"), ctx());

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CONFIG");
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("rejects an invalid mode value", async () => {
    const res = await POST(req({ sessionId: "s1", mode: "steal" }), ctx());

    expect(res.status).toBe(422);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
    expect(mocks.refreshLock).not.toHaveBeenCalled();
  });
});
