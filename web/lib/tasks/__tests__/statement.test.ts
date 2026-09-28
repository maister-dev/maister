import { describe, expect, it } from "vitest";

import { renderStatementPrompt, taskStatementSchema } from "@/lib/tasks/statement";

describe("UT-TST-03: deterministic statement rendering", () => {
  it("renders equal statements byte-identically in the fixed section order", () => {
    const first = taskStatementSchema.parse({
      context: "Existing project",
      goal: "Ship the feature",
      acceptance: ["The API responds"],
      constraints: ["Keep the current schema"],
      outOfScope: [],
      links: ["https://example.test/spec"],
      openQuestions: ["Which runner?"],
    });
    const second = taskStatementSchema.parse({
      openQuestions: ["Which runner?"],
      links: ["https://example.test/spec"],
      outOfScope: [],
      constraints: ["Keep the current schema"],
      acceptance: ["The API responds"],
      goal: "Ship the feature",
      context: "Existing project",
    });

    expect(renderStatementPrompt(first)).toBe(renderStatementPrompt(second));
    expect(renderStatementPrompt(first)).toContain("## Acceptance criteria\n- The API responds");
    expect(renderStatementPrompt(first).indexOf("## Context")).toBeLessThan(
      renderStatementPrompt(first).indexOf("## Goal"),
    );
  });
});
