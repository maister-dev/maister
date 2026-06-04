import { describe, expect, it } from "vitest";

import { runnerAgentFromFields } from "@/lib/queries/runner-agent";

describe("runnerAgentFromFields", () => {
  it("uses persisted capability agent before snapshot", () => {
    expect(
      runnerAgentFromFields({
        capabilityAgent: "codex",
        runnerSnapshot: {
          id: "claude-runner",
          adapter: "claude",
          capabilityAgent: "claude",
          model: "sonnet",
          providerKind: "anthropic",
          permissionPolicy: "default",
          sidecarId: null,
        },
        context: "run-1",
      }),
    ).toBe("codex");
  });

  it("uses runner snapshot when the direct column is absent", () => {
    expect(
      runnerAgentFromFields({
        capabilityAgent: null,
        runnerSnapshot: {
          id: "codex-runner",
          adapter: "codex",
          capabilityAgent: "codex",
          model: "glm-5.1",
          providerKind: "openai_compatible",
          permissionPolicy: "default",
          sidecarId: null,
        },
        context: "run-2",
      }),
    ).toBe("codex");
  });

  it("fails fast when no runner fields can identify the capability", () => {
    expect(() =>
      runnerAgentFromFields({
        capabilityAgent: null,
        runnerSnapshot: null,
        context: "run-corrupt",
      }),
    ).toThrow(/run-corrupt/);
  });
});
