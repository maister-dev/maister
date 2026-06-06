import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runGcCompatibilitySweepMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/scheduler/system-sweeps", () => ({
  runGcCompatibilitySweep: runGcCompatibilitySweepMock,
}));

function request(token: string): NextRequest {
  return new NextRequest("http://localhost/api/cron/gc", {
    headers: { "X-Maister-Cron-Token": token },
  });
}

describe("/api/cron/gc compatibility route", () => {
  beforeEach(() => {
    vi.resetModules();
    runGcCompatibilitySweepMock.mockReset();
    process.env.MAISTER_CRON_TOKEN = "test-token";
  });

  it("delegates to the shared system_sweep implementation and preserves the legacy response shape", async () => {
    runGcCompatibilitySweepMock.mockResolvedValue({
      worktreesPreserved: 1,
      worktreesRemoved: 2,
      revisionsRemoved: 3,
      errors: [],
    });
    const { GET } = await import("../route");

    const response = await GET(request("test-token"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runGcCompatibilitySweepMock).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      worktreesPreserved: 1,
      worktreesRemoved: 2,
      revisionsRemoved: 3,
      errors: [],
    });
  });
});
