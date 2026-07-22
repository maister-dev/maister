import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseAgentDefinition } from "@/lib/agents/definition";

const JUDGE_MD = readFileSync(
  path.join(
    __dirname,
    "fixtures",
    "core-package",
    "maister-agents",
    "experiment-judge.md",
  ),
  "utf8",
);

describe("core:experiment-judge definition", () => {
  it("parses as a manual read-only session agent with no workspace", () => {
    const parsed = parseAgentDefinition("core:experiment-judge", JUDGE_MD);

    expect(parsed).toMatchObject({
      id: "core:experiment-judge",
      name: "Experiment Judge",
      workspace: "none",
      mode: "session",
      riskTier: "read_only",
      flow: null,
    });
    expect(parsed.triggers).toEqual(["manual"]);
    expect(parsed.recommended?.runner).toBe("claude");
  });

  it("prompt is advisory-only and uses the evaluation MCP facade (refit, ADR-149)", () => {
    const parsed = parseAgentDefinition("core:experiment-judge", JUDGE_MD);

    expect(parsed.prompt).toContain("advisory only");
    expect(parsed.prompt).toContain("You never conclude an experiment");
    // Refit onto the attempt-bound evaluation_* tool family (D1a).
    expect(parsed.prompt).toContain("evaluation_context_get");
    expect(parsed.prompt).toContain("evaluation_result_submit");
    // Pairwise attempts submit an additional winner pick (ADR-147).
    expect(parsed.prompt).toContain("winner");
    // The removed experiment ext tools are gone.
    expect(parsed.prompt).not.toContain("experiment_get");
    expect(parsed.prompt).not.toContain("experiment_advise");
  });
});
