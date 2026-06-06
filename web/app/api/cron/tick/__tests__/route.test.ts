import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runSchedulerTickMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/scheduler/tick-service", () => ({
  runSchedulerTick: runSchedulerTickMock,
}));

function request(url: string, token?: string): NextRequest {
  const headers = new Headers();

  if (token) {
    headers.set("X-Maister-Cron-Token", token);
  }

  return new NextRequest(url, { headers });
}

describe("/api/cron/tick", () => {
  beforeEach(() => {
    vi.resetModules();
    runSchedulerTickMock.mockReset();
    process.env.MAISTER_CRON_TOKEN = "test-token";
  });

  it("returns 503 when the cron token is not configured", async () => {
    delete process.env.MAISTER_CRON_TOKEN;
    const { GET } = await import("../route");

    const response = await GET(request("http://localhost/api/cron/tick"));

    expect(response.status).toBe(503);
    expect(runSchedulerTickMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a mismatched bearer token", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request("http://localhost/api/cron/tick", "wrong-token"),
    );

    expect(response.status).toBe(401);
    expect(runSchedulerTickMock).not.toHaveBeenCalled();
  });

  it("dispatches all due jobs without echoing the secret", async () => {
    runSchedulerTickMock.mockResolvedValue({
      attemptedCount: 1,
      claimedCount: 1,
      succeededCount: 1,
      failedCount: 0,
      skippedCount: 0,
      attempts: [],
    });
    const { GET } = await import("../route");

    const response = await GET(
      request("http://localhost/api/cron/tick", "test-token"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runSchedulerTickMock).toHaveBeenCalledWith({ jobKind: undefined });
    expect(JSON.stringify(body)).not.toContain("test-token");
  });

  it("supports filtering by jobKind", async () => {
    runSchedulerTickMock.mockResolvedValue({
      attemptedCount: 0,
      claimedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      skippedCount: 0,
      attempts: [],
    });
    const { POST } = await import("../route");

    const response = await POST(
      request(
        "http://localhost/api/cron/tick?jobKind=agent_tick",
        "test-token",
      ),
    );

    expect(response.status).toBe(200);
    expect(runSchedulerTickMock).toHaveBeenCalledWith({
      jobKind: "agent_tick",
    });
  });

  it("returns 422 for an unknown jobKind", async () => {
    const { GET } = await import("../route");

    const response = await GET(
      request("http://localhost/api/cron/tick?jobKind=unknown", "test-token"),
    );

    expect(response.status).toBe(422);
    expect(runSchedulerTickMock).not.toHaveBeenCalled();
  });

  it("returns 207 when any claimed job failed", async () => {
    runSchedulerTickMock.mockResolvedValue({
      attemptedCount: 1,
      claimedCount: 1,
      succeededCount: 0,
      failedCount: 1,
      skippedCount: 0,
      attempts: [],
    });
    const { GET } = await import("../route");

    const response = await GET(
      request("http://localhost/api/cron/tick", "test-token"),
    );

    expect(response.status).toBe(207);
  });

  it("returns 207 when any claimed job was skipped", async () => {
    runSchedulerTickMock.mockResolvedValue({
      attemptedCount: 1,
      claimedCount: 1,
      succeededCount: 0,
      failedCount: 0,
      skippedCount: 1,
      attempts: [],
    });
    const { GET } = await import("../route");

    const response = await GET(
      request("http://localhost/api/cron/tick", "test-token"),
    );

    expect(response.status).toBe(207);
  });
});
