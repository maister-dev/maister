import { describe, expect, it } from "vitest";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { resolveExecutor } from "@/lib/executors";

function nulls() {
  return {
    task: { executorOverrideId: null },
    flow: { executorOverrideId: null, recommendedExecutorId: null },
    project: { defaultExecutorId: null },
  };
}

describe("resolveExecutor (pure 5-level chain)", () => {
  describe("happy paths — single tier set", () => {
    it("only launcher set → tier=launcher", () => {
      const r = resolveExecutor({ ...nulls(), override: "ex-launcher" });

      expect(r).toEqual({ executorId: "ex-launcher", tier: "launcher" });
    });

    it("only task override → tier=task", () => {
      const r = resolveExecutor({
        ...nulls(),
        task: { executorOverrideId: "ex-task" },
      });

      expect(r).toEqual({ executorId: "ex-task", tier: "task" });
    });

    it("only flow override → tier=flowOverride", () => {
      const r = resolveExecutor({
        ...nulls(),
        flow: {
          executorOverrideId: "ex-flow-override",
          recommendedExecutorId: null,
        },
      });

      expect(r).toEqual({
        executorId: "ex-flow-override",
        tier: "flowOverride",
      });
    });

    it("only project default → tier=projectDefault", () => {
      const r = resolveExecutor({
        ...nulls(),
        project: { defaultExecutorId: "ex-proj-default" },
      });

      expect(r).toEqual({
        executorId: "ex-proj-default",
        tier: "projectDefault",
      });
    });

    it("only flow recommended → tier=flowRecommended", () => {
      const r = resolveExecutor({
        ...nulls(),
        flow: { executorOverrideId: null, recommendedExecutorId: "ex-rec" },
      });

      expect(r).toEqual({ executorId: "ex-rec", tier: "flowRecommended" });
    });
  });

  describe("conflict resolution — higher tier wins", () => {
    it("launcher + task → launcher", () => {
      const r = resolveExecutor({
        ...nulls(),
        override: "L",
        task: { executorOverrideId: "T" },
      });

      expect(r.tier).toBe("launcher");
      expect(r.executorId).toBe("L");
    });

    it("task + flow override → task (per-task wins over per-flow rule)", () => {
      const r = resolveExecutor({
        ...nulls(),
        task: { executorOverrideId: "T" },
        flow: { executorOverrideId: "F", recommendedExecutorId: null },
      });

      expect(r.tier).toBe("task");
      expect(r.executorId).toBe("T");
    });

    it("flow override + project default → flowOverride", () => {
      const r = resolveExecutor({
        ...nulls(),
        flow: { executorOverrideId: "F", recommendedExecutorId: null },
        project: { defaultExecutorId: "P" },
      });

      expect(r.tier).toBe("flowOverride");
      expect(r.executorId).toBe("F");
    });

    it("project default + flow recommended → projectDefault", () => {
      const r = resolveExecutor({
        ...nulls(),
        project: { defaultExecutorId: "P" },
        flow: { executorOverrideId: null, recommendedExecutorId: "R" },
      });

      expect(r.tier).toBe("projectDefault");
      expect(r.executorId).toBe("P");
    });
  });

  describe("UI-prep contract — override: undefined", () => {
    it("returns deterministic 'computed' executor for task-card badge", () => {
      const r = resolveExecutor({
        override: undefined,
        task: { executorOverrideId: null },
        flow: { executorOverrideId: "F", recommendedExecutorId: "R" },
        project: { defaultExecutorId: "P" },
      });

      // Tier 1 skipped — tier 3 (flow override) wins over tier 4/5.
      expect(r.tier).toBe("flowOverride");
      expect(r.executorId).toBe("F");
    });
  });

  describe("failure mode", () => {
    it("throws EXECUTOR_UNAVAILABLE when all five tiers are nullish", () => {
      let caught: unknown;

      try {
        resolveExecutor({ ...nulls() });
      } catch (err) {
        caught = err;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as MaisterError).code).toBe("EXECUTOR_UNAVAILABLE");
      expect((caught as MaisterError).message).toMatch(/no executor resolved/);
      // Message enumerates all 5 tier sources for debuggability.
      expect((caught as MaisterError).message).toMatch(
        /launcher.*task.*flow.*default.*recommendation/,
      );
    });
  });
});
