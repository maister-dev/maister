import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));

vi.mock("@/lib/db/client", () => ({
  getDb: mocks.getDb,
}));

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/projects/demo/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/projects/[slug]/tokens auth ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("authenticates before parsing the token-create body", async () => {
    mocks.requireActiveSession.mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );
    const { POST } = await import("../route");

    const res = await POST(postRequest({ expiresAt: "not-a-date" }), {
      params: Promise.resolve({ slug: "demo" }),
    });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mocks.requireActiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.requireProjectAction).not.toHaveBeenCalled();
  });
});
