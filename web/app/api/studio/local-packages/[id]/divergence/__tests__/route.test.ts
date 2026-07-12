import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-132 (T17): the divergence route is read-only (active session, no lock),
// shape-validates `element` at the boundary, forwards `cutInstallId` for
// lineage validation inside the lib, and maps typed errors (CONFIG → 422 —
// the "source install unavailable" degradation the UI renders).
const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  getLocalPackage: vi.fn(),
  computeUpstreamDivergence: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
}));
vi.mock("@/lib/local-packages/divergence", () => ({
  computeUpstreamDivergence: mocks.computeUpstreamDivergence,
}));

import { GET } from "../route";

import { MaisterError } from "@/lib/errors";

function req(query = ""): NextRequest {
  return new NextRequest(
    new Request(`http://x/api/studio/local-packages/lp1/divergence${query}`),
  );
}

function ctx() {
  return { params: Promise.resolve({ id: "lp1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSession.mockResolvedValue({ id: "u1" });
  mocks.getLocalPackage.mockResolvedValue({ id: "lp1", status: "active" });
  mocks.computeUpstreamDivergence.mockResolvedValue({
    files: [],
    perFile: [],
    truncated: false,
    changedCount: 0,
    base: { installId: "inst-src", versionLabel: "v1" },
    compared: { kind: "working_dir" },
  });
});

describe("studio/local-packages/[id]/divergence GET", () => {
  it("forwards cutInstallId + element to the lib and returns its DTO", async () => {
    const res = await GET(req("?cutInstallId=inst-c&element=flows/f"), ctx());

    expect(res.status).toBe(200);
    expect(mocks.computeUpstreamDivergence).toHaveBeenCalledWith({
      localPackageId: "lp1",
      cutInstallId: "inst-c",
      element: "flows/f",
    });
  });

  it("rejects a path-escaping element at the boundary (422), lib never reached", async () => {
    const res = await GET(req("?element=../../etc"), ctx());

    expect(res.status).toBe(422);
    expect(mocks.computeUpstreamDivergence).not.toHaveBeenCalled();
  });

  it("maps the lineage-less CONFIG degradation to 422 for the UI panel", async () => {
    mocks.computeUpstreamDivergence.mockRejectedValueOnce(
      new MaisterError("CONFIG", "source install unavailable"),
    );

    const res = await GET(req(), ctx());

    expect(res.status).toBe(422);
    const body = await res.json();

    expect(body.code).toBe("CONFIG");
  });

  it("404s an unknown or archived package before computing", async () => {
    mocks.getLocalPackage.mockResolvedValueOnce(null);

    const res = await GET(req(), ctx());

    expect(res.status).toBe(404);
    expect(mocks.computeUpstreamDivergence).not.toHaveBeenCalled();
  });
});
