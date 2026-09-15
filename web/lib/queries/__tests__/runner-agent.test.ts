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
        },
        context: "run-2",
      }),
    ).toBe("codex");
  });

  // The write path owns the "a spawned session has a runner" invariant (launch
  // refuses before any worktree/DB write). This is a render path: a row that
  // reaches it without one is already-persisted history, and a throw here would
  // take down the portfolio, board, run and inbox screens that all read it.
  it("degrades to null when no runner fields can identify the capability", () => {
    expect(
      runnerAgentFromFields({
        capabilityAgent: null,
        runnerSnapshot: null,
        context: "run-corrupt",
      }),
    ).toBeNull();
  });

  it("degrades to null for an agent outside the adapter registry", () => {
    expect(
      runnerAgentFromFields({
        capabilityAgent: "retired-adapter",
        runnerSnapshot: null,
        context: "run-legacy",
      }),
    ).toBeNull();
  });

  // The substep regression this guards: a consensus verify / gate session row
  // written by the create ack carries a session name and a live handle but no
  // runner columns, and outranks the node's own session in
  // `activeRunSessionScalar` (live handle first, then newest).
  it("degrades to null for a substep session row with only a live handle", () => {
    expect(
      runnerAgentFromFields({
        capabilityAgent: null,
        runnerSnapshot: null,
        context: "plan_consensus-verify-1-0",
      }),
    ).toBeNull();
  });
});
