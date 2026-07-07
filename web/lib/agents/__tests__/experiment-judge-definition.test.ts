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

  it("prompt is advisory-only and uses the experiment MCP facade", () => {
    const parsed = parseAgentDefinition("core:experiment-judge", JUDGE_MD);

    expect(parsed.prompt).toContain("advisory only");
    expect(parsed.prompt).toContain("You never conclude an experiment");
    expect(parsed.prompt).toContain("experiment_get");
    expect(parsed.prompt).toContain("experiment_advise");
    expect(parsed.prompt).toContain(
      "criterion-id -> variant-key -> numeric score",
    );
  });
});
