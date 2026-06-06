import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireGlobalRoleMock = vi.hoisted(() => vi.fn());
const listSchedulerStatusRowsMock = vi.hoisted(() => vi.fn());
const createSchedulerJobMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: requireGlobalRoleMock,
}));
vi.mock("@/lib/queries/scheduler", () => ({
  listSchedulerStatusRows: listSchedulerStatusRowsMock,
}));
vi.mock("@/lib/scheduler/job-admin", () => ({
  createSchedulerJob: createSchedulerJobMock,
}));

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/scheduler-jobs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("/api/admin/scheduler-jobs", () => {
  beforeEach(() => {
    vi.resetModules();
    requireGlobalRoleMock.mockReset();
    requireGlobalRoleMock.mockResolvedValue({ id: "admin", role: "admin" });
    listSchedulerStatusRowsMock.mockReset();
    createSchedulerJobMock.mockReset();
  });

  it("lists jobs for an admin", async () => {
    listSchedulerStatusRowsMock.mockResolvedValue([
      { id: "system_sweep.default" },
    ]);
    const { GET } = await import("../route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.jobs).toEqual([{ id: "system_sweep.default" }]);
  });

  it("creates a command job from a valid body", async () => {
    createSchedulerJobMock.mockResolvedValue({ id: "ping-1" });
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({
        id: "ping-1",
        jobKind: "command",
        target: { commandKind: "http_ping", url: "https://example.com" },
        cadenceIntervalSeconds: 300,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ ok: true, id: "ping-1" });
    expect(createSchedulerJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ping-1",
        jobKind: "command",
        cadenceIntervalSeconds: 300,
      }),
    );
  });

  it("rejects a non-positive cadence with 422", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({ jobKind: "system_sweep", cadenceIntervalSeconds: 0 }),
    );

    expect(response.status).toBe(422);
    expect(createSchedulerJobMock).not.toHaveBeenCalled();
  });

  it("rejects unknown jobKind with 422", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({ jobKind: "bogus", cadenceIntervalSeconds: 60 }),
    );

    expect(response.status).toBe(422);
    expect(createSchedulerJobMock).not.toHaveBeenCalled();
  });
});
