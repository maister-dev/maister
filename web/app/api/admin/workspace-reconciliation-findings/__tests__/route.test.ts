import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireGlobalRoleMock = vi.hoisted(() => vi.fn());
const listFindingsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: requireGlobalRoleMock,
}));
vi.mock("@/lib/queries/workspace-reconciliation-findings", () => ({
  isWorkspaceReconciliationFindingState: (value: string | null) =>
    value === "quarantined" || value === "resolved",
  listWorkspaceReconciliationFindings: listFindingsMock,
}));

function request(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/workspace-reconciliation-findings${query}`,
  );
}

describe("GET /api/admin/workspace-reconciliation-findings", () => {
  beforeEach(() => {
    vi.resetModules();
    requireGlobalRoleMock.mockReset().mockResolvedValue({ id: "admin" });
    listFindingsMock.mockReset().mockResolvedValue({
      findings: [
        {
          id: "wrf_0123456789abcdef0123456789abcdef01234567",
          relativePath: "project/run",
          state: "quarantined",
        },
      ],
      nextCursor: null,
    });
  });

  it("requires a platform admin and returns only the redacted page", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("?state=quarantined&limit=25"));

    expect(response.status).toBe(200);
    expect(requireGlobalRoleMock).toHaveBeenCalledWith("admin");
    expect(listFindingsMock).toHaveBeenCalledWith({
      state: "quarantined",
      cursor: undefined,
      limit: 25,
    });
    expect(await response.json()).toEqual({
      findings: [
        {
          id: "wrf_0123456789abcdef0123456789abcdef01234567",
          relativePath: "project/run",
          state: "quarantined",
        },
      ],
      nextCursor: null,
    });
  });

  it("rejects invalid state and out-of-range limit before querying", async () => {
    const { GET } = await import("../route");

    const invalidState = await GET(request("?state=deleted"));
    const invalidLimit = await GET(request("?limit=101"));

    expect(invalidState.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
    expect(listFindingsMock).not.toHaveBeenCalled();
  });
});
