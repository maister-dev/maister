import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  assertBudgetBreachOptionAvailable,
  budgetBreachClaimRef,
  budgetMeterToPolicyField,
  budgetBreachProgressFromInput,
  evaluateBudgetBreachClaim,
  getBudgetBreachAvailableOptions,
  parseBudgetBreachResponse,
  type BudgetBreachAvailabilityContext,
} from "@/lib/runs/budget-breach-fork";

const BASE_CONTEXT: BudgetBreachAvailabilityContext = {
  runKind: "flow",
  status: "NeedsInput",
  taskId: "task-1",
  flowId: "flow-1",
  agentId: null,
  parentRunId: null,
  agentWorkspace: null,
  hasOwnedWorkspace: true,
};

function context(
  overrides: Partial<BudgetBreachAvailabilityContext>,
): BudgetBreachAvailabilityContext {
  return { ...BASE_CONTEXT, ...overrides };
}

describe("budget breach option availability", () => {
  it("offers all four options for a top-level task-bound flow with a worktree", () => {
    const options = getBudgetBreachAvailableOptions(BASE_CONTEXT);

    expect(options.map((option) => option.optionId)).toEqual([
      "raise",
      "restart",
      "park",
      "abandon",
    ]);
    expect(options.find((option) => option.optionId === "park")).toMatchObject({
      modes: ["snapshot", "export"],
      requiresBranchName: true,
    });
    expect(
      options.find((option) => option.optionId === "abandon"),
    ).toMatchObject({
      destructive: true,
      dropAllowed: true,
    });
  });

  it.each([
    [
      "orchestrator child",
      context({ parentRunId: "parent-1" }),
      ["raise", "abandon"],
    ],
    [
      "scratch worktree",
      context({ runKind: "scratch", taskId: null, flowId: null }),
      ["raise", "park", "abandon"],
    ],
    [
      "agent repo_read",
      context({
        runKind: "agent",
        taskId: "task-1",
        flowId: null,
        agentId: "agent-1",
        agentWorkspace: "repo_read",
        hasOwnedWorkspace: false,
      }),
      ["raise", "abandon"],
    ],
    [
      "top-level agent worktree",
      context({
        runKind: "agent",
        taskId: "task-1",
        flowId: null,
        agentId: "agent-1",
        agentWorkspace: "worktree",
      }),
      ["raise", "restart", "park", "abandon"],
    ],
    [
      "worktree already absent",
      context({ hasOwnedWorkspace: false }),
      ["raise", "restart", "abandon"],
    ],
  ])("renders the server matrix for %s", (_name, input, expectedOptionIds) => {
    expect(
      getBudgetBreachAvailableOptions(input).map((option) => option.optionId),
    ).toEqual(expectedOptionIds);
  });

  it("rejects unavailable options with PRECONDITION", () => {
    expect(() =>
      assertBudgetBreachOptionAvailable(
        "restart",
        context({ parentRunId: "p" }),
      ),
    ).toThrowError(MaisterError);
    expect(() =>
      assertBudgetBreachOptionAvailable(
        "restart",
        context({ parentRunId: "p" }),
      ),
    ).toThrowError(/unavailable/i);
  });
});

describe("budget breach progress DTO", () => {
  const budgetByDimension = {
    tokens: { limit: 1000, spent: 1250, source: "value" as const },
    failures: { limit: null, spent: null, source: "no-data" as const },
    wallclock: { limit: 45, spent: 12, source: "value" as const },
  };

  it("assembles the progress DTO without storing data or reading file contents", () => {
    expect(
      budgetBreachProgressFromInput({
        schema: {
          kind: "budget_breach",
          scope: "run",
          meter: "tokens",
          current: 1250,
          limit: 1000,
        },
        budgetByDimension,
        nodes: { completed: 2, total: 4, currentNodeId: "implement" },
        diff: { filesChanged: 3, insertions: 30, deletions: 5 },
        gates: {
          satisfied: 1,
          failed: 1,
          open: 2,
          unknown: 0,
        },
        wallclockMinutes: 17,
        resumeCount: 2,
      }),
    ).toEqual({
      breach: {
        dimension: "tokens",
        limit: 1000,
        spent: 1250,
        overshootPct: 25,
      },
      budgetByDimension,
      nodes: { completed: 2, total: 4, currentNodeId: "implement" },
      diff: { filesChanged: 3, insertions: 30, deletions: 5 },
      gates: {
        satisfied: 1,
        failed: 1,
        open: 2,
        unknown: 0,
      },
      wallclockMinutes: 17,
      resumeCount: 2,
    });
  });

  it("keeps missing source values explicit instead of coercing them to zero", () => {
    const dto = budgetBreachProgressFromInput({
      schema: {
        kind: "budget_breach",
        scope: "run",
        meter: "wallclock",
        current: 61,
        limit: 60,
      },
      budgetByDimension,
      nodes: { completed: null, total: null, currentNodeId: null },
      diff: null,
      gates: {
        satisfied: 0,
        failed: 0,
        open: 0,
        unknown: 0,
      },
      wallclockMinutes: null,
      resumeCount: 0,
    });

    expect(dto?.budgetByDimension.failures).toEqual({
      limit: null,
      spent: null,
      source: "no-data",
    });
    expect(dto?.diff).toBeNull();
    expect(dto?.nodes.completed).toBeNull();
  });

  it("returns null for non-budget or malformed schemas", () => {
    expect(
      budgetBreachProgressFromInput({
        schema: { kind: "permission" },
        budgetByDimension,
        nodes: { completed: null, total: null, currentNodeId: null },
        diff: null,
        gates: {
          satisfied: 0,
          failed: 0,
          open: 0,
          unknown: 0,
        },
        wallclockMinutes: null,
        resumeCount: 0,
      }),
    ).toBeNull();
  });
});

describe("budget breach response parsing", () => {
  it.each([
    [
      { optionId: "raise", raiseTo: 2000 },
      { breachedMeter: "tokens" as const, breachedLimit: 1000 },
      {
        optionId: "raise",
        dimension: "tokens",
        newLimit: 2000,
      },
    ],
    [
      {
        optionId: "raise",
        response: { dimension: "failures", newLimit: 4 },
      },
      { breachedMeter: "failures" as const, breachedLimit: 3 },
      {
        optionId: "raise",
        dimension: "failures",
        newLimit: 4,
      },
    ],
    [
      { optionId: "raise", response: 2000 },
      { breachedMeter: "tokens" as const, breachedLimit: 1000 },
      {
        optionId: "raise",
        dimension: "tokens",
        newLimit: 2000,
      },
    ],
    [
      { optionId: "raise", response: "2000" },
      { breachedMeter: "tokens" as const, breachedLimit: 1000 },
      {
        optionId: "raise",
        dimension: "tokens",
        newLimit: 2000,
      },
    ],
    [
      { optionId: "park", response: { mode: "snapshot" } },
      { breachedMeter: "tokens" as const, breachedLimit: 1000 },
      { optionId: "park", mode: "snapshot", branchName: null },
    ],
    [
      {
        optionId: "park",
        response: { mode: "export", branchName: "maister/budget-parked" },
      },
      { breachedMeter: "tokens" as const, breachedLimit: 1000 },
      {
        optionId: "park",
        mode: "export",
        branchName: "maister/budget-parked",
      },
    ],
    [
      { optionId: "abandon", response: { dropWorkspace: true } },
      { breachedMeter: "tokens" as const, breachedLimit: 1000 },
      { optionId: "abandon", dropWorkspace: true },
    ],
    [
      { optionId: "abandon", dropWorkspace: true },
      { breachedMeter: "tokens" as const, breachedLimit: 1000 },
      { optionId: "abandon", dropWorkspace: true },
    ],
  ])("canonicalizes %j", (body, parseContext, expected) => {
    expect(parseBudgetBreachResponse(body, parseContext)).toEqual(expected);
  });

  it("validates raise by breached dimension and limit", () => {
    expect(() =>
      parseBudgetBreachResponse(
        {
          optionId: "raise",
          response: { dimension: "wallclock", newLimit: 60 },
        },
        { breachedMeter: "tokens", breachedLimit: 1000 },
      ),
    ).toThrowError(/dimension/i);

    expect(() =>
      parseBudgetBreachResponse(
        { optionId: "raise", response: { newLimit: 1000 } },
        { breachedMeter: "tokens", breachedLimit: 1000 },
      ),
    ).toThrowError(/greater/i);
  });

  it("maps breached meters to the existing execution-policy fields", () => {
    expect(budgetMeterToPolicyField("tokens")).toBe("maxTokens");
    expect(budgetMeterToPolicyField("failures")).toBe("consecutiveFailures");
    expect(budgetMeterToPolicyField("wallclock")).toBe("wallClockMinutes");
  });
});

describe("budget breach shared claim gate", () => {
  const restartPayload = { optionId: "restart" as const };
  const raisePayload = {
    optionId: "raise" as const,
    dimension: "tokens" as const,
    newLimit: 2000,
  };

  it("treats the first unclaimed response as fresh", () => {
    expect(
      evaluateBudgetBreachClaim({
        storedResponse: null,
        respondedAt: null,
        incoming: raisePayload,
      }),
    ).toEqual({ kind: "fresh" });
  });

  it("allows same-payload idempotency for delivered rows and rejects different payloads", () => {
    expect(
      evaluateBudgetBreachClaim({
        storedResponse: raisePayload,
        respondedAt: new Date("2026-07-02T10:00:00.000Z"),
        incoming: raisePayload,
      }),
    ).toEqual({ kind: "idempotent" });

    expect(
      evaluateBudgetBreachClaim({
        storedResponse: raisePayload,
        respondedAt: new Date("2026-07-02T10:00:00.000Z"),
        incoming: restartPayload,
      }),
    ).toEqual({ kind: "conflict" });
  });

  it("re-drives matching staged composites and conflicts on different staged payloads", () => {
    expect(
      evaluateBudgetBreachClaim({
        storedResponse: { ...restartPayload, stage: "claimed" },
        respondedAt: null,
        incoming: restartPayload,
      }),
    ).toEqual({ kind: "re-drive", stage: "claimed" });

    expect(
      evaluateBudgetBreachClaim({
        storedResponse: { ...restartPayload, stage: "claimed" },
        respondedAt: null,
        incoming: raisePayload,
      }),
    ).toEqual({ kind: "conflict" });
  });

  it("reads the durable staged-composite ref for retry recovery", () => {
    expect(
      budgetBreachClaimRef({
        ...restartPayload,
        stage: "terminalized",
        ref: "restart-run-2",
      }),
    ).toBe("restart-run-2");
    expect(budgetBreachClaimRef({ ...restartPayload, ref: "   " })).toBeNull();
    expect(budgetBreachClaimRef({ ...restartPayload })).toBeNull();
  });

  it("allows any option to re-claim a pre-boundary failed composite", () => {
    expect(
      evaluateBudgetBreachClaim({
        storedResponse: { ...restartPayload, stage: "failed" },
        respondedAt: null,
        incoming: raisePayload,
      }),
    ).toEqual({ kind: "re-claimable" });
  });
});
