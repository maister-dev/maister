import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const requireGlobalRoleMock = vi.hoisted(() => vi.fn());
const updateSchedulerJobMock = vi.hoisted(() => vi.fn());
const deleteSchedulerJobMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: requireGlobalRoleMock,
}));
vi.mock("@/lib/scheduler/job-admin", () => ({
  updateSchedulerJob: updateSchedulerJobMock,
  deleteSchedulerJob: deleteSchedulerJobMock,
}));

function patchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/scheduler-jobs/job-1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ jobId: "job-1" }) };

describe("/api/admin/scheduler-jobs/[jobId]", () => {
  beforeEach(() => {
    requireGlobalRoleMock.mockReset();
    requireGlobalRoleMock.mockResolvedValue({ id: "admin", role: "admin" });
    updateSchedulerJobMock.mockReset();
    deleteSchedulerJobMock.mockReset();
  });

  it("disables a job via PATCH enabled=false", async () => {
    updateSchedulerJobMock.mockResolvedValue(undefined);
    const { PATCH } = await import("../route");

    const response = await PATCH(patchRequest({ enabled: false }), params);

    expect(response.status).toBe(200);
    expect(updateSchedulerJobMock).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ enabled: false }),
    );
  });

  it("rejects an empty PATCH body with 422", async () => {
    const { PATCH } = await import("../route");

    const response = await PATCH(patchRequest({}), params);

    expect(response.status).toBe(422);
    expect(updateSchedulerJobMock).not.toHaveBeenCalled();
  });

  it("maps a not-found update to 409", async () => {
    updateSchedulerJobMock.mockRejectedValue(
      new MaisterError("PRECONDITION", "scheduler job not found: job-1"),
    );
    const { PATCH } = await import("../route");

    const response = await PATCH(patchRequest({ enabled: true }), params);

    expect(response.status).toBe(409);
  });

  it("deletes a job", async () => {
    deleteSchedulerJobMock.mockResolvedValue(undefined);
    const { DELETE } = await import("../route");

    const response = await DELETE(
      new NextRequest("http://localhost/api/admin/scheduler-jobs/job-1", {
        method: "DELETE",
      }),
      params,
    );

    expect(response.status).toBe(200);
    expect(deleteSchedulerJobMock).toHaveBeenCalledWith("job-1");
  });
});
