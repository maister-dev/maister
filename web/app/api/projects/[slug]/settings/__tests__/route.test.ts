import type { NextRequest } from "next/server";

import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

const state: {
  projects: Row[];
  runners: Row[];
  updates: Array<{ tableName: string; values: Row }>;
} = {
  projects: [],
  runners: [],
  updates: [],
};

function rowsForTable(table: unknown): Row[] {
  const tableName = getTableName(table as never);

  if (tableName === "projects") return state.projects;
  if (tableName === "platform_acp_runners") return state.runners;

  return [];
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => rowsForTable(table),
    }),
  }),
  update: (table: unknown) => ({
    set: (values: Row) => {
      const tableName = getTableName(table as never);

      state.updates.push({ tableName, values });

      return {
        where: async () => {
          if (tableName !== "projects") return;

          Object.assign(state.projects[0], values);
        },
      };
    },
  }),
};

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

function request(body: unknown): NextRequest {
  return new Request("http://x/api/projects/demo/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function patch(slug: string, body: unknown) {
  const { PATCH } = await import("../route");

  return PATCH(request(body), { params: Promise.resolve({ slug }) });
}

describe("PATCH /api/projects/[slug]/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.projects = [
      {
        id: "project-1",
        slug: "demo",
        archivedAt: null,
        defaultRunnerId: "runner-1",
        deliveryPolicyDefault: null,
      },
    ];
    state.runners = [
      {
        id: "runner-1",
        enabled: true,
        readinessStatus: "Ready",
      },
    ];
    state.updates = [];
    mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
    mocks.requireProjectAction.mockResolvedValue({ role: "owner" });
  });

  it("sets, clears, and re-sets the delivery-policy default through one aggregate PATCH", async () => {
    const firstPolicy = {
      strategy: "merge",
      push: "never",
      trigger: "manual",
      targetBranch: "main",
    };
    const secondPolicy = {
      strategy: "rebase_merge",
      push: "on_success",
      trigger: "auto_on_ready",
      targetBranch: "release",
    };

    const setRes = await patch("demo", { deliveryPolicyDefault: firstPolicy });
    const clearRes = await patch("demo", { deliveryPolicyDefault: null });
    const resetRes = await patch("demo", {
      deliveryPolicyDefault: secondPolicy,
    });
    const resetBody = (await resetRes.json()) as {
      deliveryPolicyDefault: unknown;
    };

    expect(setRes.status).toBe(200);
    expect(clearRes.status).toBe(200);
    expect(resetRes.status).toBe(200);
    expect(resetBody.deliveryPolicyDefault).toEqual(secondPolicy);
    expect(state.updates.map((entry) => entry.values)).toEqual([
      { deliveryPolicyDefault: firstPolicy },
      { deliveryPolicyDefault: null },
      { deliveryPolicyDefault: secondPolicy },
    ]);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "editSettings",
    );
  });

  it("rejects body project identifiers instead of trusting them", async () => {
    const res = await patch("demo", {
      projectId: "attacker-project",
      deliveryPolicyDefault: null,
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(state.updates).toEqual([]);
    expect(mocks.requireProjectAction).not.toHaveBeenCalled();
  });
});
