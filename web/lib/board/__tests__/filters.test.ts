import type { BacklogCard, BoardAgent, BoardData } from "@/lib/queries/board";
import type { BoardColumn } from "@/lib/board";

import { describe, expect, it } from "vitest";

import {
  BOARD_FILTER_NONE,
  filterBoardData,
  getBoardFilterOptions,
  normalizeBoardFilters,
} from "@/lib/board/filters";

const COLUMNS: BoardColumn[] = [
  "Backlog",
  "Prepare",
  "InProduction",
  "OnReview",
  "InDelivery",
  "Crashed",
  "Done",
];

function card(
  taskId: string,
  options: {
    flow?: string | null;
    agent?: BoardAgent | null;
    priority?: "low" | "normal" | "high" | "urgent";
    touchedAt?: string;
  } = {},
): BacklogCard {
  return {
    taskId,
    number: Number.parseInt(taskId, 10),
    keyRef: `TEST-${taskId}`,
    title: taskId,
    prompt: taskId,
    flowRef: options.flow ?? null,
    touchedAt: options.touchedAt,
    agent: options.agent ?? null,
    flowIncompatibility: null,
    priority: "low",
    taskPriority: options.priority ?? "normal",
    queuePaused: false,
    triageConfidence: null,
    awaitingClarification: false,
    runCount: 0,
    blockedBy: [],
    clarificationPending: false,
    flowId: null,
    triageStatus: null,
    runnerId: null,
    baseBranch: null,
    targetBranch: null,
    promotionMode: null,
    executionPolicy: null,
    relations: [],
    childTasks: [],
    parentTask: null,
    latestRun: null,
  };
}

function board(...backlog: BacklogCard[]): BoardData {
  const columns = Object.fromEntries(
    COLUMNS.map((column) => [
      column,
      {
        column,
        backlog: column === "Backlog" ? backlog : [],
        flight: [],
        total: column === "Backlog" ? backlog.length : 0,
      },
    ]),
  ) as unknown as BoardData["columns"];

  return {
    columns,
    relationCandidates: [],
    totalTasks: backlog.length,
    inProd: 0,
    backlog: backlog.length,
    merged7d: 0,
  };
}

describe("board filters", () => {
  const data = board(
    card("1", {
      flow: "review",
      agent: "codex",
      priority: "urgent",
      touchedAt: "2026-10-18T09:00:00.000Z",
    }),
    card("2", {
      flow: "implement",
      agent: "claude",
      priority: "normal",
      touchedAt: "2026-10-10T09:00:00.000Z",
    }),
    card("3", { touchedAt: "2026-08-01T09:00:00.000Z" }),
  );

  it("derives real menu options, including explicit unassigned values", () => {
    expect(getBoardFilterOptions(data)).toEqual({
      flows: ["implement", "review"],
      agents: ["claude", "codex"],
      hasFlowless: true,
      hasAgentless: true,
    });
  });

  it("filters cards and recalculates the visible column count", () => {
    const options = getBoardFilterOptions(data);
    const filters = normalizeBoardFilters(
      { flow: "review", agent: "codex", priority: "urgent" },
      options,
    );
    const filtered = filterBoardData(
      data,
      filters,
      new Date("2026-10-18T12:00:00.000Z"),
    );

    expect(filtered.columns.Backlog.backlog.map((item) => item.taskId)).toEqual(
      ["1"],
    );
    expect(filtered.columns.Backlog.total).toBe(1);
    expect(filtered.totalTasks).toBe(1);
  });

  it("supports agentless work and touched presets without hiding old work by default", () => {
    const options = getBoardFilterOptions(data);
    const unassigned = filterBoardData(
      data,
      normalizeBoardFilters({ agent: BOARD_FILTER_NONE }, options),
      new Date("2026-10-18T12:00:00.000Z"),
    );
    const recent = filterBoardData(
      data,
      normalizeBoardFilters({ touched: "7d" }, options),
      new Date("2026-10-18T12:00:00.000Z"),
    );

    expect(
      unassigned.columns.Backlog.backlog.map((item) => item.taskId),
    ).toEqual(["3"]);
    expect(recent.columns.Backlog.backlog.map((item) => item.taskId)).toEqual([
      "1",
    ]);
    expect(
      filterBoardData(
        data,
        normalizeBoardFilters({}, options),
        new Date("2026-10-18T12:00:00.000Z"),
      ).totalTasks,
    ).toBe(3);
  });
});
