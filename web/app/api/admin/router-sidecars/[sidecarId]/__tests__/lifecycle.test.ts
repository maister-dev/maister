import type { NextRequest } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

// ADR-094 — POST /api/admin/router-sidecars/[sidecarId]/start|stop. Mocks the
// supervisor-client boundary + auth + db; asserts the admin gate, missing-sidecar
// 409, EXECUTOR_UNAVAILABLE → 503 mapping, and that the supervisor-reported state
// is echoed verbatim.
const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  startSidecar: vi.fn(),
  stopSidecar: vi.fn(),
}));

type Row = Record<string, unknown>;
const state = { sidecars: [] as Row[] };
const fakeDb = {
  select: () => ({
    from: () => ({ where: async () => state.sidecars }),
  }),
};

vi.mock("@/lib/authz", () => ({ requireGlobalRole: mocks.requireGlobalRole }));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/supervisor-client", () => ({
  startSidecar: mocks.startSidecar,
  stopSidecar: mocks.stopSidecar,
}));

function ctx(sidecarId: string): { params: Promise<{ sidecarId: string }> } {
  return { params: Promise.resolve({ sidecarId }) };
}

function req(): NextRequest {
  return new Request("http://x/api/admin/router-sidecars/ccr-default/start", {
    method: "POST",
    body: "{}",
  }) as NextRequest;
}

const CCR: Row = {
  id: "ccr-default",
  lifecycle: "managed",
  configPath: "~/.claude-code-router/config.json",
  baseUrl: "http://127.0.0.1:3456",
  healthcheckUrl: "http://127.0.0.1:3456/health",
};

describe("admin router sidecar start/stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.sidecars = [];
    mocks.requireGlobalRole.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.startSidecar.mockResolvedValue({ ok: true, state: "ready" });
    mocks.stopSidecar.mockResolvedValue({ ok: true, state: "idle" });
  });

  it("start: forwards the sidecar config and echoes the state (200)", async () => {
    state.sidecars = [CCR];
    const { POST } = await import("../start/route");
    const res = await POST(req(), ctx("ccr-default"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "ready" });
    expect(mocks.startSidecar).toHaveBeenCalledWith(
      "ccr-default",
      expect.objectContaining({
        lifecycle: "managed",
        configPath: "~/.claude-code-router/config.json",
      }),
    );
  });

  it("start: 409 PRECONDITION when the sidecar is not found", async () => {
    state.sidecars = [];
    const { POST } = await import("../start/route");
    const res = await POST(req(), ctx("nope"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
    expect(mocks.startSidecar).not.toHaveBeenCalled();
  });

  it("start: 403 for a non-admin", async () => {
    mocks.requireGlobalRole.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "requires admin"),
    );
    const { POST } = await import("../start/route");
    const res = await POST(req(), ctx("ccr-default"));

    expect(res.status).toBe(403);
  });

  it("start: maps a supervisor EXECUTOR_UNAVAILABLE to 503", async () => {
    state.sidecars = [CCR];
    mocks.startSidecar.mockRejectedValue(
      new MaisterError("EXECUTOR_UNAVAILABLE", "config missing"),
    );
    const { POST } = await import("../start/route");
    const res = await POST(req(), ctx("ccr-default"));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EXECUTOR_UNAVAILABLE");
  });

  it("stop: forwards to the per-instance stop and echoes the state (200)", async () => {
    state.sidecars = [CCR];
    const { POST } = await import("../stop/route");
    const res = await POST(req(), ctx("ccr-default"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "idle" });
    expect(mocks.stopSidecar).toHaveBeenCalledWith("ccr-default");
  });

  it("stop: 409 PRECONDITION when the sidecar is not found", async () => {
    state.sidecars = [];
    const { POST } = await import("../stop/route");
    const res = await POST(req(), ctx("nope"));

    expect(res.status).toBe(409);
    expect(mocks.stopSidecar).not.toHaveBeenCalled();
  });
});
