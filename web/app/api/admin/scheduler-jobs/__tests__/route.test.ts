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

async function configError(message: string): Promise<Error> {
  const { MaisterError } = await import("@/lib/errors");

  return new MaisterError("CONFIG", message);
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

  it("creates a webhook delivery job from a valid body", async () => {
    createSchedulerJobMock.mockResolvedValue({
      id: "webhook_delivery.default",
    });
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({
        id: "webhook_delivery.default",
        jobKind: "webhook_delivery",
        target: {},
        cadenceIntervalSeconds: 60,
      }),
    );

    expect(response.status).toBe(201);
    expect(createSchedulerJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "webhook_delivery.default",
        jobKind: "webhook_delivery",
        target: {},
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

  it("rejects creating a run_schedule job — the dispatcher is system-seeded", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      postRequest({ jobKind: "run_schedule", cadenceIntervalSeconds: 60 }),
    );

    expect(response.status).toBe(422);
    expect(createSchedulerJobMock).not.toHaveBeenCalled();
  });

  it("rejects system-managed singleton kinds at create time", async () => {
    const { POST } = await import("../route");

    for (const jobKind of [
      "agent_tick",
      "run_schedule",
      "domain_event_dispatch",
    ]) {
      const response = await POST(
        postRequest({ jobKind, cadenceIntervalSeconds: 60 }),
      );

      expect(response.status).toBe(422);
    }

    expect(createSchedulerJobMock).not.toHaveBeenCalled();
  });

  it("maps command HTTP target URL validation failures to 422", async () => {
    const { POST } = await import("../route");

    createSchedulerJobMock.mockRejectedValueOnce(
      await configError(
        "command http_ping url must use the http or https scheme",
      ),
    );

    const response = await POST(
      postRequest({
        jobKind: "command",
        target: {
          commandKind: "http_ping",
          timeoutMs: 5000,
          url: "ftp://example.com",
        },
        cadenceIntervalSeconds: 60,
      }),
    );

    expect(response.status).toBe(422);
    expect(createSchedulerJobMock).toHaveBeenCalledOnce();
  });

  it("maps command HTTP target timeout validation failures to 422", async () => {
    const { POST } = await import("../route");

    createSchedulerJobMock.mockRejectedValueOnce(
      await configError("command timeoutMs must be a positive finite number"),
    );

    const response = await POST(
      postRequest({
        jobKind: "command",
        target: {
          commandKind: "http_ping",
          timeoutMs: 0,
          url: "https://example.com",
        },
        cadenceIntervalSeconds: 60,
      }),
    );

    expect(response.status).toBe(422);
    expect(createSchedulerJobMock).toHaveBeenCalledOnce();
  });

  it("maps command target typos and partial numeric timeout strings to 422", async () => {
    const { POST } = await import("../route");

    createSchedulerJobMock
      .mockRejectedValueOnce(
        await configError("command http_ping target has unknown field: typo"),
      )
      .mockRejectedValueOnce(
        await configError("command timeoutMs must be a positive finite number"),
      );

    const typoResponse = await POST(
      postRequest({
        jobKind: "command",
        target: {
          commandKind: "http_ping",
          url: "https://example.com",
          typo: true,
        },
        cadenceIntervalSeconds: 60,
      }),
    );
    const timeoutResponse = await POST(
      postRequest({
        jobKind: "command",
        target: {
          commandKind: "http_ping",
          timeoutMs: "5s",
          url: "https://example.com",
        },
        cadenceIntervalSeconds: 60,
      }),
    );

    expect(typoResponse.status).toBe(422);
    expect(await typoResponse.json()).toMatchObject({
      code: "CONFIG",
    });
    expect(timeoutResponse.status).toBe(422);
    expect(await timeoutResponse.json()).toMatchObject({
      code: "CONFIG",
    });
    expect(createSchedulerJobMock).toHaveBeenCalledTimes(2);
  });

  it("maps flow-run target task validation failures to 422", async () => {
    const { POST } = await import("../route");

    createSchedulerJobMock.mockRejectedValueOnce(
      await configError("flow_run task id is required"),
    );

    const response = await POST(
      postRequest({
        jobKind: "flow_run",
        target: {
          runnerId: "codex-default",
          taskId: "",
        },
        cadenceIntervalSeconds: 60,
      }),
    );

    expect(response.status).toBe(422);
    expect(createSchedulerJobMock).toHaveBeenCalledOnce();
  });
});
