import type { ReadinessState } from "@/lib/flows/graph/readiness-core";

import { beforeEach, describe, expect, it, vi } from "vitest";

const readinessMocks = vi.hoisted(() => ({
  computeReadinessByRun: vi.fn(),
}));

const lineageMocks = vi.hoisted(() => ({
  isLaunchedLineageRun: vi.fn(),
}));

vi.mock("@/lib/queries/readiness-batch", () => ({
  computeReadinessByRun: readinessMocks.computeReadinessByRun,
}));

vi.mock("@/lib/evaluations/membership", () => ({
  isLaunchedLineageRun: lineageMocks.isLaunchedLineageRun,
}));

import {
  isMechanicallyPromotable,
  listProjectPromotable,
} from "@/lib/ext-activity/promotable";

type QueryRows = Record<string, unknown>[];

class FakeSelectQuery implements PromiseLike<QueryRows> {
  constructor(private readonly rows: QueryRows) {}

  from(): this {
    return this;
  }

  where(): this {
    return this;
  }

  orderBy(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  innerJoin(): this {
    return this;
  }

  leftJoin(): this {
    return this;
  }

  then<TResult1 = QueryRows, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryRows) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.rows).then(onfulfilled, onrejected);
  }
}

function makeClient(responses: QueryRows[]): {
  select: () => FakeSelectQuery;
  selectCalls: () => number;
} {
  const queue = [...responses];
  let calls = 0;

  return {
    select() {
      calls += 1;

      return new FakeSelectQuery(queue.shift() ?? []);
    },
    selectCalls: () => calls,
  };
}

function candidateRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    runId: "run-1",
    runKind: "flow",
    status: "Review",
    taskId: "task-1",
    taskTitle: "Ship the thing",
    projectTaskKey: "OPS",
    taskNumber: 7,
    targetBranch: "main",
    reviewEnteredAt: new Date("2026-07-27T09:00:00.000Z"),
    ...over,
  };
}

describe("REQ-A2 — the mechanical promotable layer is an allow-list", () => {
  it("REQ-A2 AC1 — admits a flow run in Review whose readiness is phase-ready", () => {
    expect(
      isMechanicallyPromotable({
        runKind: "flow",
        status: "Review",
        readiness: "ready",
      }),
    ).toBe(true);
  });

  it("REQ-A2 AC1 — rejects a non-flow kind, a non-Review status, and a non-ready readiness", () => {
    expect(
      isMechanicallyPromotable({
        runKind: "agent",
        status: "Review",
        readiness: "ready",
      }),
    ).toBe(false);
    expect(
      isMechanicallyPromotable({
        runKind: "flow",
        status: "Running",
        readiness: "ready",
      }),
    ).toBe(false);
    expect(
      isMechanicallyPromotable({
        runKind: "flow",
        status: "Review",
        readiness: "blocked",
      }),
    ).toBe(false);
  });

  it("REQ-A2 AC1 / D6a — `overridden` is promotable, because a waived blocking gate outranks `ready`", () => {
    expect(
      isMechanicallyPromotable({
        runKind: "flow",
        status: "Review",
        readiness: "overridden",
      }),
    ).toBe(true);
  });

  it("REQ-A2 AC3 — an unrecognized run status is rejected by default, not admitted by a deny-list", () => {
    expect(
      isMechanicallyPromotable({
        runKind: "flow",
        status: "SomeFutureStatus",
        readiness: "ready",
      }),
    ).toBe(false);
    expect(
      isMechanicallyPromotable({
        runKind: "someFutureKind",
        status: "Review",
        readiness: "ready",
      }),
    ).toBe(false);
  });

  it("REQ-A3 — a candidate with no readiness entry is rejected, never treated as ready", () => {
    expect(
      isMechanicallyPromotable({
        runKind: "flow",
        status: "Review",
        readiness: undefined,
      }),
    ).toBe(false);
  });
});

describe("listProjectPromotable", () => {
  beforeEach(() => {
    readinessMocks.computeReadinessByRun.mockReset();
    lineageMocks.isLaunchedLineageRun.mockReset();
    lineageMocks.isLaunchedLineageRun.mockResolvedValue(false);
  });

  function readiness(entries: Record<string, ReadinessState>) {
    readinessMocks.computeReadinessByRun.mockResolvedValue(
      new Map(Object.entries(entries)),
    );
  }

  it("REQ-A1 AC3 — assembles the item from the run, its workspace and its task", async () => {
    const client = makeClient([[candidateRow()]]);

    readiness({ "run-1": "ready" });

    const items = await listProjectPromotable("proj-1", {
      db: client as never,
    });

    expect(items).toEqual([
      {
        runId: "run-1",
        taskId: "task-1",
        taskKey: "OPS-7",
        taskTitle: "Ship the thing",
        targetBranch: "main",
        readiness: "ready",
        inReviewSince: new Date("2026-07-27T09:00:00.000Z"),
      },
    ]);
  });

  it("REQ-A1 AC3 — `targetBranch` is null when the workspace has none, and the task fields degrade to null", async () => {
    const client = makeClient([
      [
        candidateRow({
          targetBranch: null,
          taskId: null,
          taskTitle: null,
          taskNumber: null,
        }),
      ],
    ]);

    readiness({ "run-1": "overridden" });

    const items = await listProjectPromotable("proj-1", {
      db: client as never,
    });

    expect(items[0]).toMatchObject({
      targetBranch: null,
      taskId: null,
      taskKey: null,
      taskTitle: null,
      readiness: "overridden",
    });
  });

  it("REQ-A3 AC1 — computes readiness with exactly ONE bulk call over the candidate id set", async () => {
    const client = makeClient([
      [
        candidateRow({ runId: "run-a" }),
        candidateRow({ runId: "run-b" }),
        candidateRow({ runId: "run-c" }),
      ],
    ]);

    readiness({ "run-a": "ready", "run-b": "blocked", "run-c": "overridden" });

    await listProjectPromotable("proj-1", { db: client as never });

    expect(readinessMocks.computeReadinessByRun).toHaveBeenCalledTimes(1);
    expect(readinessMocks.computeReadinessByRun).toHaveBeenCalledWith(client, [
      "run-a",
      "run-b",
      "run-c",
    ]);
  });

  it("REQ-A3 — skips the readiness pass entirely when there are no candidates", async () => {
    const client = makeClient([[]]);

    await expect(
      listProjectPromotable("proj-1", { db: client as never }),
    ).resolves.toEqual([]);
    expect(readinessMocks.computeReadinessByRun).not.toHaveBeenCalled();
  });

  it("REQ-A2 AC2 — drops a launched-lineage participant even though it is mechanically green", async () => {
    const client = makeClient([
      [candidateRow({ runId: "run-plain" }), candidateRow({ runId: "run-lineage" })],
    ]);

    readiness({ "run-plain": "ready", "run-lineage": "ready" });
    lineageMocks.isLaunchedLineageRun.mockImplementation(
      async (_db: unknown, runId: string) => runId === "run-lineage",
    );

    const items = await listProjectPromotable("proj-1", {
      db: client as never,
    });

    expect(items.map((i) => i.runId)).toEqual(["run-plain"]);
  });

  it("REQ-A2 AC4 — orders by inReviewSince ascending, runId ascending as tiebreak, nulls last", async () => {
    const client = makeClient([
      [
        candidateRow({
          runId: "run-late",
          reviewEnteredAt: new Date("2026-07-27T12:00:00.000Z"),
        }),
        candidateRow({ runId: "run-null", reviewEnteredAt: null }),
        candidateRow({
          runId: "run-b-early",
          reviewEnteredAt: new Date("2026-07-27T08:00:00.000Z"),
        }),
        candidateRow({
          runId: "run-a-early",
          reviewEnteredAt: new Date("2026-07-27T08:00:00.000Z"),
        }),
      ],
    ]);

    readiness({
      "run-late": "ready",
      "run-null": "ready",
      "run-b-early": "ready",
      "run-a-early": "ready",
    });

    const items = await listProjectPromotable("proj-1", {
      db: client as never,
    });

    expect(items.map((i) => i.runId)).toEqual([
      "run-a-early",
      "run-b-early",
      "run-late",
      "run-null",
    ]);
  });
});
