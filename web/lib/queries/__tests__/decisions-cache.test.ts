// ATN-05 / MEMO-01 / MEMO-02 / MEMO-03 (docs/system-analytics/attention.md,
// docs/system-analytics/identity-access.md §Per-render memoization) — verifies
// per-render memoization and key normalization of `getDecisionsQueue` and
// `getDecisionsCount` under emulated React `cache()`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getActionableMock, getDbMock } = vi.hoisted(() => ({
  getActionableMock: vi.fn(),
  getDbMock: vi.fn(),
}));

vi.mock("react", async (importActual) => {
  const { emulatedReactCache } =
    await import("@/test-support/react-cache-emulation");

  return {
    ...(await importActual<typeof import("react")>()),
    cache: emulatedReactCache,
  };
});

vi.mock("@/lib/db/client", () => ({
  getDb: () => getDbMock(),
}));

vi.mock("@/lib/queries/visible-projects", () => ({
  decisionQueueGrants: vi.fn(() => true),
  getActionableProjectIds: (...args: unknown[]) => getActionableMock(...args),
}));

vi.mock("@/lib/queries/portfolio", () => ({
  getCrossProjectHitlInbox: vi.fn(async () => ({ items: [], count: 0 })),
}));

vi.mock("@/lib/agents/incidents", () => ({
  listAgentIncidentGroups: vi.fn(async () => []),
  listOperationalAttention: vi.fn(async () => []),
  listUngroupedOperationalAttention: vi.fn(async () => []),
}));

vi.mock("@/lib/queries/task-relations", () => ({
  getOpenRelationBlockers: vi.fn(async () => new Map()),
}));

import { withEmulatedRender } from "@/test-support/react-cache-emulation";
import {
  decisionsCacheKey,
  decodeDecisionsScope,
  getDecisionsCount,
  getDecisionsQueue,
} from "@/lib/queries/decisions";

function fakeDb() {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => []),
      innerJoin: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
      then: (resolve: (value: unknown[]) => void) => resolve([]),
    })),
  }));

  return { select } as never;
}

describe("decisions per-render memoization (ATN-05 / MEMO-01..03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActionableMock.mockResolvedValue([]);
    getDbMock.mockReturnValue(fakeDb());
  });

  it("ATN-05 / MEMO-01 shares one computation across equivalent scopes in a single render", async () => {
    await withEmulatedRender(async () => {
      await getDecisionsCount("user-1", "member");
      await getDecisionsQueue("user-1", "member");
      await getDecisionsQueue("user-1", "member", {});
      await getDecisionsQueue("user-1", "member", {
        companyIds: ["co-b", "co-a", "co-a"],
      });
      await getDecisionsQueue("user-1", "member", {
        companyIds: ["co-a", "co-b"],
      });
    });

    // Two distinct normalized keys: (project="", company="*") and
    // (project="", company='["co-a","co-b"]').
    expect(getActionableMock).toHaveBeenCalledTimes(2);
  });

  it("MEMO-01 / MEMO-02 decisionsCacheKey round-trips via decodeDecisionsScope and distinguishes [] from undefined", () => {
    expect(decisionsCacheKey(undefined)).toEqual(["", "*"]);
    expect(decisionsCacheKey({})).toEqual(["", "*"]);
    expect(decisionsCacheKey({ projectId: "proj-1" })).toEqual(["proj-1", "*"]);
    expect(decisionsCacheKey({ companyIds: [] })).toEqual(["", "[]"]);
    expect(decisionsCacheKey({ companyIds: ["co-b", "co-a", "co-a"] })).toEqual(
      ["", '["co-a","co-b"]'],
    );

    // Critical invariant (EDGE-ATN-09): empty array MUST NOT equal absent.
    expect(decisionsCacheKey({ companyIds: [] })).not.toEqual(
      decisionsCacheKey(undefined),
    );

    expect(decodeDecisionsScope("", "*")).toEqual({});
    expect(decodeDecisionsScope("proj-1", "*")).toEqual({
      projectId: "proj-1",
    });
    expect(decodeDecisionsScope("", "[]")).toEqual({ companyIds: [] });
    expect(decodeDecisionsScope("proj-1", '["co-a","co-b"]')).toEqual({
      projectId: "proj-1",
      companyIds: ["co-a", "co-b"],
    });
  });

  it("MEMO-03 an explicit client bypasses the render cache and computes on every call", async () => {
    const explicitClient = fakeDb();

    await withEmulatedRender(async () => {
      await getDecisionsQueue("user-1", "member", {}, explicitClient);
      await getDecisionsQueue("user-1", "member", {}, explicitClient);
    });

    expect(getActionableMock).toHaveBeenCalledTimes(2);
  });
});
