import { describe, expect, it } from "vitest";

import {
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITIES,
  type TaskPriority,
  isTaskPriority,
  weightOf,
} from "./criticality";

import { isMaisterError } from "@/lib/errors";

describe("criticality dictionary (ADR-121)", () => {
  it("maps every enum value to a weight (total coverage)", () => {
    for (const priority of TASK_PRIORITIES) {
      expect(Number.isInteger(weightOf(priority))).toBe(true);
    }
  });

  it("orders weights strictly monotonic low < normal < high < urgent", () => {
    const ordered = TASK_PRIORITIES.map((p) => weightOf(p));

    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1]);
    }
  });

  it("falls back to the normal weight for null/undefined (no-task default)", () => {
    expect(weightOf(null)).toBe(weightOf(DEFAULT_TASK_PRIORITY));
    expect(weightOf(undefined)).toBe(weightOf("normal"));
  });

  it("fails closed with CONFIG on an out-of-set string (corruption)", () => {
    try {
      weightOf("critical" as unknown as TaskPriority);
      throw new Error("expected weightOf to throw");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("CONFIG");
    }
  });

  it("isTaskPriority recognizes the closed set only", () => {
    expect(isTaskPriority("urgent")).toBe(true);
    expect(isTaskPriority("normal")).toBe(true);
    expect(isTaskPriority("critical")).toBe(false);
    expect(isTaskPriority(2)).toBe(false);
    expect(isTaskPriority(null)).toBe(false);
  });
});
