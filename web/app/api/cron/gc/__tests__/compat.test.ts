import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestSystemSweepMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/scheduler/tick-service", () => ({
  requestSystemSweep: requestSystemSweepMock,
}));

function request(token: string): NextRequest {
  return new NextRequest("http://localhost/api/cron/gc", {
    headers: { "X-Maister-Cron-Token": token },
  });
}

describe("/api/cron/gc compatibility route", () => {
  beforeEach(() => {
    vi.resetModules();
    requestSystemSweepMock.mockReset();
    process.env.MAISTER_CRON_TOKEN = "test-token";
  });

  it("requests the canonical system_sweep through the scheduler claim", async () => {
    requestSystemSweepMock.mockResolvedValue({
      attemptedCount: 1,
      claimedCount: 1,
      succeededCount: 1,
      failedCount: 0,
      skippedCount: 0,
      attempts: [],
    });
    const { GET } = await import("../route");

    const response = await GET(request("test-token"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(requestSystemSweepMock).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      attemptedCount: 1,
      claimedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    });
  });

  it("returns accepted when an active scheduler claim owns the sweep", async () => {
    requestSystemSweepMock.mockResolvedValue({
      attemptedCount: 0,
      claimedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      skippedCount: 0,
      attempts: [],
    });
    const { GET } = await import("../route");

    const response = await GET(request("test-token"));

    expect(response.status).toBe(202);
  });
});
