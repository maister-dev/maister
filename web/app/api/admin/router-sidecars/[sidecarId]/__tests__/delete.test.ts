import type { NextRequest } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

// DELETE /api/admin/router-sidecars/[sidecarId] — usage-guard + managed stop +
// row delete run as one serialized transaction (a FOR UPDATE lock on the
// sidecar row); a managed stop that the supervisor cannot confirm aborts the
// transaction so the row survives. Mocks auth + db + the usage-guard + the
// supervisor stop boundary. The transaction is mocked as a pass-through that
// runs the callback against the same chainable; the FOR UPDATE row-lock and the
// race it closes are exercised against real Postgres in delete.integration.test.
// The usage-guard is mocked directly (not driven through fakeDb) because the
// route's loadSidecarUsageReferences query shape differs from the simple
// select().from().where() the fakeDb models.
const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  loadSidecarUsageReferences: vi.fn(),
  stopSidecar: vi.fn(),
  deleteWhere: vi.fn(),
}));

type Row = Record<string, unknown>;
const state = { sidecars: [] as Row[] };
// select().from().where() resolves to the rows AND carries .for("update") for
// the route's FOR UPDATE lock form (mirrors the takeover test's mock shape).
const selectChain = {
  from: () => ({
    where: () =>
      Object.assign(Promise.resolve(state.sidecars), {
        for: async () => state.sidecars,
      }),
  }),
};
const txLike = {
  select: () => selectChain,
  delete: () => ({ where: mocks.deleteWhere }),
};
const fakeDb = {
  select: () => selectChain,
  delete: () => ({ where: mocks.deleteWhere }),
  transaction: async (fn: (tx: typeof txLike) => Promise<unknown>) =>
    fn(txLike),
};

vi.mock("@/lib/authz", () => ({ requireGlobalRole: mocks.requireGlobalRole }));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/acp-runners/usage", () => ({
  loadSidecarUsageReferences: mocks.loadSidecarUsageReferences,
}));
vi.mock("@/lib/supervisor-client", () => ({
  stopSidecar: mocks.stopSidecar,
  checkSupervisorDiagnostics: vi.fn(),
}));

function ctx(sidecarId: string): { params: Promise<{ sidecarId: string }> } {
  return { params: Promise.resolve({ sidecarId }) };
}

function req(): NextRequest {
  return new Request("http://x/api/admin/router-sidecars/ccr-default", {
    method: "DELETE",
  }) as NextRequest;
}

const MANAGED: Row = { id: "ccr-default", lifecycle: "managed" };
const EXTERNAL: Row = { id: "ext-ccr", lifecycle: "external" };

describe("admin router sidecar DELETE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.sidecars = [MANAGED];
    mocks.requireGlobalRole.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.loadSidecarUsageReferences.mockResolvedValue([]);
    mocks.stopSidecar.mockResolvedValue({ ok: true, state: "idle" });
    mocks.deleteWhere.mockResolvedValue(undefined);
  });

  it("deletes an unreferenced sidecar (204) and stops a managed process first", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(req(), ctx("ccr-default"));

    expect(res.status).toBe(204);
    expect(mocks.stopSidecar).toHaveBeenCalledWith("ccr-default");
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("blocks delete (409 CONFLICT) when a runner references the sidecar; no row delete", async () => {
    mocks.loadSidecarUsageReferences.mockResolvedValue([
      { kind: "runnerSidecar", runnerId: "r1", sidecarId: "ccr-default" },
    ]);
    const { DELETE } = await import("../route");
    const res = await DELETE(req(), ctx("ccr-default"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(mocks.stopSidecar).not.toHaveBeenCalled();
  });

  it("returns 409 PRECONDITION when the sidecar is unknown", async () => {
    state.sidecars = [];
    const { DELETE } = await import("../route");
    const res = await DELETE(req(), ctx("nope"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin and attempts no delete or stop", async () => {
    mocks.requireGlobalRole.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "requires admin"),
    );
    const { DELETE } = await import("../route");
    const res = await DELETE(req(), ctx("ccr-default"));

    expect(res.status).toBe(403);
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(mocks.stopSidecar).not.toHaveBeenCalled();
  });

  it("refuses the delete (503) and keeps the row when a managed stop is not confirmed", async () => {
    mocks.stopSidecar.mockRejectedValue(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor down"),
    );
    const { DELETE } = await import("../route");
    const res = await DELETE(req(), ctx("ccr-default"));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("EXECUTOR_UNAVAILABLE");
    expect(mocks.stopSidecar).toHaveBeenCalledWith("ccr-default");
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  it("does not call stopSidecar for an external sidecar", async () => {
    state.sidecars = [EXTERNAL];
    const { DELETE } = await import("../route");
    const res = await DELETE(req(), ctx("ext-ccr"));

    expect(res.status).toBe(204);
    expect(mocks.stopSidecar).not.toHaveBeenCalled();
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
  });
});
