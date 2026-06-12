import type { NextRequest } from "next/server";

import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

const state: {
  runs: Row[];
  updates: Row[];
} = {
  runs: [],
  updates: [],
};

const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => {
        if (getTableName(table as never) === "runs") return state.runs;

        return [];
      },
    }),
  }),
  update: (table: unknown) => ({
    set: (values: Row) => {
      state.updates.push(values);

      return {
        where: () => ({
          returning: async () => {
            if (getTableName(table as never) !== "runs") return [];

            const run = state.runs[0];
            const policy = run?.deliveryPolicySnapshot as
              | { trigger?: string }
              | null
              | undefined;

            if (
              run?.status !== "Review" ||
              policy?.trigger !== "auto_on_ready"
            ) {
              return [];
            }

            Object.assign(run, values);

            return [{ id: run.id }];
          },
        }),
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
  return new Request("http://x/api/runs/run-1/delivery-policy", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function patch(body: unknown) {
  const { PATCH } = await import("../route");

  return PATCH(request(body), { params: Promise.resolve({ runId: "run-1" }) });
}

describe("PATCH /api/runs/[runId]/delivery-policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.runs = [
      {
        id: "run-1",
        projectId: "project-1",
        status: "Review",
        deliveryPolicySnapshot: {
          strategy: "merge",
          push: "never",
          trigger: "auto_on_ready",
          targetBranch: "main",
        },
      },
    ];
    state.updates = [];
    mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
    mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  });

  it("switches an auto-on-ready Review run to manual with a CAS update", async () => {
    const res = await patch({ action: "switch_to_manual" });
    const body = (await res.json()) as {
      deliveryPolicy: { trigger: string };
    };

    expect(res.status).toBe(200);
    expect(body.deliveryPolicy.trigger).toBe("manual");
    expect(state.runs[0].deliveryPolicySnapshot).toMatchObject({
      trigger: "manual",
    });
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "promoteRun",
    );
  });

  it("rejects missing action bodies as CONFIG before mutating", async () => {
    const res = await patch({});
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(state.updates).toEqual([]);
  });

  it("returns CONFLICT when the CAS trigger no longer matches", async () => {
    state.runs[0].deliveryPolicySnapshot = {
      strategy: "merge",
      push: "never",
      trigger: "manual",
      targetBranch: "main",
    };

    const res = await patch({ action: "switch_to_manual" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
  });
});
