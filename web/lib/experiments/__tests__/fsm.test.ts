import { describe, expect, it } from "vitest";

import {
  assertExperimentTransition,
  deriveExperimentProgressStatus,
  isExperimentTransitionAllowed,
} from "@/lib/experiments/fsm";
import type {
  ExperimentMemberRunStatus,
  ExperimentStatus,
} from "@/lib/experiments/types";

function member(
  variantKey: string,
  status: ExperimentMemberRunStatus,
): { variantKey: string; status: ExperimentMemberRunStatus } {
  return { variantKey, status };
}

describe("experiment FSM", () => {
  it.each([
    ["draft", "running"],
    ["running", "comparable"],
    ["comparable", "running"],
    ["draft", "abandoned"],
    ["running", "abandoned"],
    ["comparable", "abandoned"],
    ["comparable", "concluded"],
  ] satisfies Array<[ExperimentStatus, ExperimentStatus]>)(
    "allows %s -> %s",
    (from, to) => {
      expect(isExperimentTransitionAllowed(from, to)).toBe(true);
      expect(() => assertExperimentTransition(from, to)).not.toThrow();
    },
  );

  it.each([
    ["draft", "comparable"],
    ["draft", "concluded"],
    ["running", "concluded"],
    ["concluded", "running"],
    ["abandoned", "running"],
    ["concluded", "abandoned"],
  ] satisfies Array<[ExperimentStatus, ExperimentStatus]>)(
    "rejects %s -> %s",
    (from, to) => {
      expect(isExperimentTransitionAllowed(from, to)).toBe(false);
      expect(() => assertExperimentTransition(from, to)).toThrowError(
        /invalid experiment status transition/,
      );
    },
  );

  it("derives comparable only when all members are Review or terminal and at least two variants ran", () => {
    expect(
      deriveExperimentProgressStatus({
        currentStatus: "running",
        memberRuns: [
          member("a", "Review"),
          member("b", "Done"),
          member("b", "Failed"),
        ],
      }),
    ).toBe("comparable");
  });

  it("keeps running while any member is active or paused for HITL", () => {
    for (const status of [
      "Pending",
      "Running",
      "NeedsInput",
      "NeedsInputIdle",
      "HumanWorking",
      "WaitingOnChildren",
    ] satisfies ExperimentMemberRunStatus[]) {
      expect(
        deriveExperimentProgressStatus({
          currentStatus: "comparable",
          memberRuns: [member("a", "Review"), member("b", status)],
        }),
      ).toBe("running");
    }
  });

  it("never marks a single-variant experiment comparable", () => {
    expect(
      deriveExperimentProgressStatus({
        currentStatus: "running",
        memberRuns: [member("a", "Review"), member("a", "Done")],
      }),
    ).toBe("running");
  });

  it("leaves terminal experiment statuses final during progress derivation", () => {
    expect(
      deriveExperimentProgressStatus({
        currentStatus: "concluded",
        memberRuns: [member("a", "Running"), member("b", "Done")],
      }),
    ).toBe("concluded");

    expect(
      deriveExperimentProgressStatus({
        currentStatus: "abandoned",
        memberRuns: [member("a", "Review"), member("b", "Done")],
      }),
    ).toBe("abandoned");
  });
});
