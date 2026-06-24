import { describe, expect, it } from "vitest";

import { resolveAgentExecutionPolicy } from "@/lib/agents/execution-policy";
import { expandExecutionPolicy } from "@/lib/runs/execution-policy";

describe("resolveAgentExecutionPolicy — autoApply → B1/B2 axes", () => {
  it("no policy (neither instance nor recommended) → bare supervised, no overrides", () => {
    const policy = resolveAgentExecutionPolicy({});

    expect(policy).toEqual({ preset: "supervised" });
  });

  it("autoApply='permissions' → auto_approve permissions, human gate still stops (с чел)", () => {
    const policy = resolveAgentExecutionPolicy({
      recommended: { autoApply: "permissions" },
    });
    const r = expandExecutionPolicy(policy);

    expect(r.permissions).toBe("auto_approve");
    expect(r.humanGate).toBe("stop");
  });

  it("autoApply='full' → auto_approve permissions AND auto_pass human gate (без чел)", () => {
    const policy = resolveAgentExecutionPolicy({
      recommended: { autoApply: "full" },
    });
    const r = expandExecutionPolicy(policy);

    expect(r.permissions).toBe("auto_approve");
    expect(r.humanGate).toBe("auto_pass");
  });

  it("autoApply='off' forces normal HITL even over an auto base preset", () => {
    const policy = resolveAgentExecutionPolicy({
      recommended: { autoApply: "off" },
      base: { preset: "unattended" },
    });
    const r = expandExecutionPolicy(policy);

    expect(policy.preset).toBe("unattended");
    expect(r.permissions).toBe("ask");
    expect(r.humanGate).toBe("stop");
  });

  it("autoApply unset → inherits the base preset's permissions/humanGate", () => {
    const policy = resolveAgentExecutionPolicy({
      base: { preset: "assisted" },
    });
    const r = expandExecutionPolicy(policy);

    // assisted = auto_approve permissions, stop human gate — untouched.
    expect(r.permissions).toBe("auto_approve");
    expect(r.humanGate).toBe("stop");
  });
});

describe("resolveAgentExecutionPolicy — onBudgetBreach axis", () => {
  it("folds the recommended onBudgetBreach onto the policy", () => {
    const policy = resolveAgentExecutionPolicy({
      recommended: { onBudgetBreach: "terminate_restorable" },
    });

    expect(policy.overrides?.onBudgetBreach).toBe("terminate_restorable");
  });

  it("leaves onBudgetBreach unset when the agent declares none", () => {
    const policy = resolveAgentExecutionPolicy({
      recommended: { autoApply: "permissions" },
    });

    expect(policy.overrides?.onBudgetBreach).toBeUndefined();
  });
});

describe("resolveAgentExecutionPolicy — Q3 per-field precedence (instance → recommended)", () => {
  it("instance autoApply beats recommended autoApply", () => {
    const policy = resolveAgentExecutionPolicy({
      instanceOverride: { autoApply: "full" },
      recommended: { autoApply: "off" },
    });
    const r = expandExecutionPolicy(policy);

    expect(r.permissions).toBe("auto_approve");
    expect(r.humanGate).toBe("auto_pass");
  });

  it("merges fields independently — instance sets autoApply, recommended sets onBudgetBreach", () => {
    const policy = resolveAgentExecutionPolicy({
      instanceOverride: { autoApply: "permissions" },
      recommended: { onBudgetBreach: "escalate" },
    });
    const r = expandExecutionPolicy(policy);

    expect(r.permissions).toBe("auto_approve");
    expect(policy.overrides?.onBudgetBreach).toBe("escalate");
  });

  it("instance onBudgetBreach beats recommended onBudgetBreach", () => {
    const policy = resolveAgentExecutionPolicy({
      instanceOverride: { onBudgetBreach: "terminate" },
      recommended: { onBudgetBreach: "escalate" },
    });

    expect(policy.overrides?.onBudgetBreach).toBe("terminate");
  });
});
