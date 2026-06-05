import type { FlowYamlV1 } from "@/lib/config.schema";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadRunManifest } from "@/lib/queries/run-manifest";
import { upsertNodeLayout } from "@/lib/runs/flow-layout-write";

vi.mock("@/lib/queries/run-manifest", () => ({
  loadRunManifest: vi.fn(),
}));

// A minimal linear manifest whose compiled graph contains node "plan".
const manifest: FlowYamlV1 = {
  schemaVersion: 1,
  name: "demo",
  steps: [
    { id: "plan", type: "agent", mode: "new-session", prompt: "/aif-plan" },
    { id: "review", type: "human", form_schema: "./r.json" },
  ],
} as FlowYamlV1;

type UpsertCall = {
  values: Record<string, unknown>;
  set: Record<string, unknown>;
};

function makeFakeDb() {
  const calls: UpsertCall[] = [];
  // FIXME(any): minimal drizzle-like fake DB capturing the upsert chain.
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
          calls.push({ values, set: cfg.set });

          return Promise.resolve();
        },
      }),
    }),
  } as any;

  return { db, calls };
}

beforeEach(() => {
  vi.mocked(loadRunManifest).mockReset();
});

describe("upsertNodeLayout", () => {
  it("upserts a known node with the resolved flowId, nodeId, x, y, userId", async () => {
    vi.mocked(loadRunManifest).mockResolvedValue({
      flowId: "flow-1",
      manifest,
    });
    const { db, calls } = makeFakeDb();

    const result = await upsertNodeLayout({
      runId: "run-1",
      nodeId: "plan",
      x: 12,
      y: 34,
      userId: "user-1",
      db,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toMatchObject({
      flowId: "flow-1",
      nodeId: "plan",
      x: 12,
      y: 34,
      updatedByUserId: "user-1",
    });
  });

  it("throws CONFIG and does not write when the nodeId is not in the manifest", async () => {
    vi.mocked(loadRunManifest).mockResolvedValue({
      flowId: "flow-1",
      manifest,
    });
    const { db, calls } = makeFakeDb();

    await expect(
      upsertNodeLayout({
        runId: "run-1",
        nodeId: "ghost",
        x: 1,
        y: 2,
        userId: "user-1",
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(calls).toHaveLength(0);
  });

  it("throws CONFIG and does not write when the run has no flow", async () => {
    vi.mocked(loadRunManifest).mockResolvedValue(null);
    const { db, calls } = makeFakeDb();

    await expect(
      upsertNodeLayout({
        runId: "scratch-1",
        nodeId: "plan",
        x: 1,
        y: 2,
        userId: "user-1",
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(calls).toHaveLength(0);
  });

  it("throws CONFIG and does not write for a non-finite x", async () => {
    vi.mocked(loadRunManifest).mockResolvedValue({
      flowId: "flow-1",
      manifest,
    });
    const { db, calls } = makeFakeDb();

    await expect(
      upsertNodeLayout({
        runId: "run-1",
        nodeId: "plan",
        x: Number.POSITIVE_INFINITY,
        y: 2,
        userId: "user-1",
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(calls).toHaveLength(0);
  });

  it("throws CONFIG and does not write for an out-of-bounds y", async () => {
    vi.mocked(loadRunManifest).mockResolvedValue({
      flowId: "flow-1",
      manifest,
    });
    const { db, calls } = makeFakeDb();

    await expect(
      upsertNodeLayout({
        runId: "run-1",
        nodeId: "plan",
        x: 1,
        y: 1e8,
        userId: "user-1",
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(calls).toHaveLength(0);
  });
});
