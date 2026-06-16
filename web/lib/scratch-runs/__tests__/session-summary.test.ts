import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildScratchSessionFlowSummary,
  getScratchSessionSummary,
} from "@/lib/scratch-runs/session-summary";

// Hoist-safe fake db: getScratchSessionSummary fires two `select().from().where()`
// chains via Promise.all (scratch row first, capability-profile row second). The
// fake returns queued rows in that call order — the test sets `queue` per case.
const dbMock = vi.hoisted(() => {
  const state: { queue: unknown[][] } = { queue: [] };

  return {
    state,
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(state.queue.shift() ?? []),
        }),
      }),
    }),
  };
});

vi.mock("@/lib/db/client", () => ({ getDb: dbMock.getDb }));

describe("buildScratchSessionFlowSummary", () => {
  it("maps a scratch session into a flow-summary with dialog + capability rows", () => {
    const summary = buildScratchSessionFlowSummary(
      {
        dialogStatus: "WaitingForUser",
        mcpCount: 2,
        skillCount: 1,
        ruleCount: 0,
      },
      { title: "Session", dialog: "Dialog", capabilities: "Capabilities" },
    );

    expect(summary.title).toBe("Session");
    expect(summary.subtitle).toBe("WaitingForUser");
    expect(summary.nodes).toHaveLength(2);
    expect(summary.nodes[0]).toMatchObject({
      id: "dialog",
      label: "Dialog",
      status: "WaitingForUser",
    });
    expect(summary.nodes[1]).toMatchObject({
      id: "capabilities",
      label: "Capabilities",
      status: "2 · 1 · 0",
    });
  });
});

describe("getScratchSessionSummary", () => {
  beforeEach(() => {
    dbMock.state.queue = [];
  });

  it("returns null when the run has no scratch row", async () => {
    dbMock.state.queue = [[], []];

    expect(await getScratchSessionSummary("run-1")).toBeNull();
  });

  it("counts the selected capability ids from the profile row", async () => {
    dbMock.state.queue = [
      [{ dialogStatus: "WaitingForUser" }],
      [
        {
          selectedMcpIds: ["a", "b"],
          selectedSkillIds: ["s"],
          selectedRuleIds: [],
        },
      ],
    ];

    expect(await getScratchSessionSummary("run-1")).toEqual({
      dialogStatus: "WaitingForUser",
      mcpCount: 2,
      skillCount: 1,
      ruleCount: 0,
    });
  });

  it("falls back to zero counts when no capability profile exists", async () => {
    dbMock.state.queue = [[{ dialogStatus: "Running" }], []];

    expect(await getScratchSessionSummary("run-1")).toEqual({
      dialogStatus: "Running",
      mcpCount: 0,
      skillCount: 0,
      ruleCount: 0,
    });
  });

  it("falls back to zero counts when the profile id arrays are null", async () => {
    dbMock.state.queue = [
      [{ dialogStatus: "Running" }],
      [
        {
          selectedMcpIds: null,
          selectedSkillIds: null,
          selectedRuleIds: null,
        },
      ],
    ];

    expect(await getScratchSessionSummary("run-1")).toMatchObject({
      mcpCount: 0,
      skillCount: 0,
      ruleCount: 0,
    });
  });
});
