import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  getLocalPackage: vi.fn(),
  acquireLock: vi.fn(),
  refreshLock: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({ requireGlobalRole: mocks.requireGlobalRole }));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
}));
vi.mock("@/lib/local-packages/lock", () => ({
  acquireLock: mocks.acquireLock,
  refreshLock: mocks.refreshLock,
}));

import { POST } from "../route";

function req(body: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1/lock-refresh", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function ctx() {
  return { params: Promise.resolve({ id: "lp1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireGlobalRole.mockResolvedValue({ id: "u1", role: "member" });
  mocks.getLocalPackage.mockResolvedValue({ id: "lp1", status: "active" });
  mocks.acquireLock.mockResolvedValue({
    held: true,
    heldByMe: true,
    holderLabel: null,
    expiresAt: new Date(),
  });
  mocks.refreshLock.mockResolvedValue({
    held: true,
    heldByMe: true,
    holderLabel: null,
    expiresAt: new Date(),
  });
});

describe("POST .../lock-refresh", () => {
  it("defaults to acquire mode", async () => {
    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(200);
    expect(mocks.requireGlobalRole).toHaveBeenCalledWith("member");
    expect(mocks.acquireLock).toHaveBeenCalledWith("lp1", "u1", "s1");
    expect(mocks.refreshLock).not.toHaveBeenCalled();
  });

  it("uses refresh-only mode for heartbeats", async () => {
    const res = await POST(req({ sessionId: "s1", mode: "refresh" }), ctx());

    expect(res.status).toBe(200);
    expect(mocks.refreshLock).toHaveBeenCalledWith("lp1", "s1");
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });
});
