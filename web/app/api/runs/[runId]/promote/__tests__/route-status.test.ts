import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import { promoteRun } from "@/lib/runs/promote";

// =============================================================================
// M18 Phase 3 — RED until the route's `httpStatusForCode` gains the
// EXECUTOR_UNAVAILABLE→503 case (it does NOT have it today; the default branch
// maps it to 500). Codex F7: a retryable transient push/PR-API failure must map
// to HTTP 503, distinct from the 409 config/conflict failures.
//
// This isolates the route's CODE→STATUS mapping by stubbing `promoteRun` to
// throw a chosen MaisterError, so the assertion is purely on the route's
// classification — no DB / git / provider fakes needed.
// =============================================================================

vi.mock("@/lib/runs/promote", () => ({
  promoteRun: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: { id: "user-1", role: "member" },
    role: "member",
  })),
}));

async function invokePost(body: unknown) {
  const { POST } = await import("../route");
  const runId = "run-status";
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  vi.mocked(promoteRun).mockReset();
});

describe("POST /api/runs/[runId]/promote — httpStatusForCode (Codex F7)", () => {
  it("maps EXECUTOR_UNAVAILABLE → 503 (retryable transient push/PR-API failure)", async () => {
    vi.mocked(promoteRun).mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "push rejected (retryable)"),
    );

    const res = await invokePost({
      mode: "pull_request",
      reviewedTargetCommit: "tip00000",
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
  });

  it("maps PRECONDITION → 409 (config failure: CLI missing / remote unset / unsupported)", async () => {
    vi.mocked(promoteRun).mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "PR mode unsupported for provider"),
    );

    const res = await invokePost({
      mode: "pull_request",
      reviewedTargetCommit: "tip00000",
    });

    expect(res.status).toBe(409);
  });

  it("maps CONFLICT → 409 (merge conflict / superseded promotion)", async () => {
    vi.mocked(promoteRun).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "promotion already in progress"),
    );

    const res = await invokePost({
      mode: "pull_request",
      reviewedTargetCommit: "tip00000",
    });

    expect(res.status).toBe(409);
  });

  it("maps a successful PR promotion to 200 with the PR url/number", async () => {
    vi.mocked(promoteRun).mockResolvedValueOnce({
      ok: true,
      mode: "pull_request",
      pullRequestUrl: "https://github.com/org/repo/pull/77",
      prNumber: 77,
    } as never);

    const res = await invokePost({
      mode: "pull_request",
      reviewedTargetCommit: "tip00000",
    });
    const body = (await res.json()) as {
      pullRequestUrl: string;
      prNumber: number;
    };

    expect(res.status).toBe(200);
    expect(body.pullRequestUrl).toBe("https://github.com/org/repo/pull/77");
    expect(body.prNumber).toBe(77);
  });
});
