import type {
  RunTimeline,
  TimelineEntry,
  TimelineGate,
} from "@/lib/queries/run";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getRunTimeline } from "@/lib/queries/run";
import { getRunNodeStatuses } from "@/lib/queries/run-node-status";

// getRunTimeline uses the module getDb() (NOT injectable), so mock it directly.
vi.mock("@/lib/queries/run", () => ({
  getRunTimeline: vi.fn(),
}));

// getRunNodeStatuses reads the run row (status + currentStepId) via db ?? getDb().
const runRowState: { rows: Record<string, unknown>[] } = { rows: [] };

const selectChain = () => ({
  from: () => ({
    where: async () => runRowState.rows,
  }),
});

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({ select: selectChain }),
}));

function entry(over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    nodeAttemptId: "att-" + Math.random().toString(36).slice(2),
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    decision: null,
    reworkFromNode: null,
    acpSessionId: null,
    autoRetry: false,
    startedAt: "2026-06-01T00:00:00.000Z",
    endedAt: null,
    gates: [],
    handoff: null,
    ...over,
  };
}

function gate(over: Partial<TimelineGate> = {}): TimelineGate {
  return {
    gateId: "g-" + Math.random().toString(36).slice(2),
    kind: "command_check",
    mode: "blocking",
    status: "passed",
    verdict: null,
    stale: false,
    endedAt: null,
    ...over,
  };
}

function mockTimeline(entries: TimelineEntry[]): void {
  const timeline: RunTimeline = { entries, assignmentEvents: [] };

  vi.mocked(getRunTimeline).mockResolvedValue(timeline);
}

beforeEach(() => {
  vi.mocked(getRunTimeline).mockReset();
  runRowState.rows = [{ status: "Running", currentStepId: "implement" }];
});

describe("getRunNodeStatuses — highest attempt wins", () => {
  it("surfaces the highest-attempt entry's status for a node", async () => {
    mockTimeline([
      entry({ nodeId: "implement", attempt: 1, status: "Failed" }),
      entry({ nodeId: "implement", attempt: 2, status: "Succeeded" }),
    ]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.implement.status).toBe("Succeeded");
    expect(result.nodes.implement.attempt).toBe(2);
  });
});

describe("getRunNodeStatuses — status surfaced as-is", () => {
  it("surfaces a Reworked status verbatim", async () => {
    mockTimeline([entry({ nodeId: "review", status: "Reworked" })]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.review.status).toBe("Reworked");
  });

  it("surfaces a Stale status verbatim", async () => {
    mockTimeline([entry({ nodeId: "checks", status: "Stale" })]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.checks.status).toBe("Stale");
  });
});

describe("getRunNodeStatuses — gate rollup (worst blocking)", () => {
  it("a blocking failed gate dominates an advisory passed gate", async () => {
    mockTimeline([
      entry({
        nodeId: "checks",
        gates: [
          gate({ mode: "blocking", status: "failed" }),
          gate({ mode: "advisory", status: "passed" }),
        ],
      }),
    ]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.checks.rollup).toBe("failed");
  });

  it("a single blocking passed gate rolls up to passed", async () => {
    mockTimeline([
      entry({
        nodeId: "checks",
        gates: [gate({ mode: "blocking", status: "passed" })],
      }),
    ]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.checks.rollup).toBe("passed");
  });

  it("rolls up to 'none' when there are no blocking gates", async () => {
    mockTimeline([
      entry({
        nodeId: "checks",
        gates: [gate({ mode: "advisory", status: "failed" })],
      }),
    ]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.checks.rollup).toBe("none");
  });

  it("an advisory failed gate NEVER makes the rollup failed", async () => {
    mockTimeline([
      entry({
        nodeId: "checks",
        gates: [
          gate({ mode: "blocking", status: "passed" }),
          gate({ mode: "advisory", status: "failed" }),
        ],
      }),
    ]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.checks.rollup).toBe("passed");
  });
});

describe("getRunNodeStatuses — runtime gate summary", () => {
  it("counts total, blocking, advisory, failed blocking, and stale blocking gates", async () => {
    mockTimeline([
      entry({
        nodeId: "checks",
        gates: [
          gate({ mode: "blocking", status: "failed" }),
          gate({ mode: "blocking", status: "stale" }),
          gate({ mode: "advisory", status: "failed" }),
        ],
      }),
    ]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.checks.gateSummary).toEqual({
      total: 3,
      blockingTotal: 2,
      advisoryTotal: 1,
      worstBlockingStatus: "failed",
      failedBlocking: 1,
      staleBlocking: 1,
    });
  });

  it("uses the existing rollup priority for worstBlockingStatus", async () => {
    mockTimeline([
      entry({
        nodeId: "checks",
        gates: [
          gate({ mode: "blocking", status: "passed" }),
          gate({ mode: "blocking", status: "running" }),
          gate({ mode: "blocking", status: "stale" }),
        ],
      }),
    ]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.checks.rollup).toBe("stale");
    expect(result.nodes.checks.gateSummary.worstBlockingStatus).toBe("stale");
  });

  it("returns a stable zero summary for nodes without gates", async () => {
    mockTimeline([entry({ nodeId: "plan", gates: [] })]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.plan.gateSummary).toEqual({
      total: 0,
      blockingTotal: 0,
      advisoryTotal: 0,
      worstBlockingStatus: null,
      failedBlocking: 0,
      staleBlocking: 0,
    });
  });
});

describe("getRunNodeStatuses — gate blocking flag", () => {
  it("derives gate.blocking from mode === 'blocking'", async () => {
    mockTimeline([
      entry({
        nodeId: "checks",
        gates: [
          gate({ mode: "blocking", status: "passed" }),
          gate({ mode: "advisory", status: "passed" }),
        ],
      }),
    ]);

    const result = await getRunNodeStatuses("run-1");

    expect(result.nodes.checks.gates).toEqual([
      { blocking: true, status: "passed" },
      { blocking: false, status: "passed" },
    ]);
  });
});

describe("getRunNodeStatuses — run row echo", () => {
  it("echoes the run's currentStepId and status from the run row", async () => {
    mockTimeline([entry()]);
    runRowState.rows = [{ status: "NeedsInput", currentStepId: "review" }];

    const result = await getRunNodeStatuses("run-1");

    expect(result.currentStepId).toBe("review");
    expect(result.runStatus).toBe("NeedsInput");
  });
});
