import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  getLocalPackage: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({ requireGlobalRole: mocks.requireGlobalRole }));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
}));
vi.mock("@/lib/local-packages/lock", () => ({
  releaseLock: mocks.releaseLock,
}));

import { POST } from "../route";

function req(body: unknown): NextRequest {
  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1/lock-release", {
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
  mocks.releaseLock.mockResolvedValue(undefined);
});

describe("POST .../lock-release", () => {
  it("releases the caller session under the member gate", async () => {
    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(200);
    expect(mocks.requireGlobalRole).toHaveBeenCalledWith("member");
    expect(mocks.releaseLock).toHaveBeenCalledWith("lp1", "s1");
  });

  it("rejects a missing session id before release", async () => {
    const res = await POST(req({}), ctx());

    expect(res.status).toBe(422);
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it("denies unauthorized sessions without release", async () => {
    mocks.requireGlobalRole.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "denied"),
    );

    const res = await POST(req({ sessionId: "s1" }), ctx());

    expect(res.status).toBe(403);
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });
});
