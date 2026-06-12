import { describe, expect, it } from "vitest";

import { decideFire } from "@/lib/run-schedules/dispatch";

describe("decideFire (overlap policy × launchability × cap matrix)", () => {
  it("skips terminal targets under every policy, regardless of cap", () => {
    for (const policy of ["skip", "queue_one", "start_anyway"] as const) {
      for (const capFull of [false, true]) {
        expect(
          decideFire({ policy, launchability: "target_terminal", capFull }),
        ).toEqual({ action: "skip", outcome: "skipped_target_terminal" });
      }
    }
  });

  it("skips crashed targets under every policy", () => {
    for (const policy of ["skip", "queue_one", "start_anyway"] as const) {
      expect(
        decideFire({ policy, launchability: "crashed", capFull: false }),
      ).toEqual({ action: "skip", outcome: "skipped_crashed" });
    }
  });

  it("skips relation-blocked targets under every policy, regardless of cap (ADR-078)", () => {
    for (const policy of ["skip", "queue_one", "start_anyway"] as const) {
      for (const capFull of [false, true]) {
        expect(
          decideFire({ policy, launchability: "blocked", capFull }),
        ).toEqual({ action: "skip", outcome: "skipped_blocked" });
      }
    }
  });

  it("skips flowless (unconfigured) targets under every policy, regardless of cap (M34, ADR-089)", () => {
    for (const policy of ["skip", "queue_one", "start_anyway"] as const) {
      for (const capFull of [false, true]) {
        expect(
          decideFire({ policy, launchability: "unconfigured", capFull }),
        ).toEqual({ action: "skip", outcome: "skipped_unconfigured" });
      }
    }
  });

  it("busy task: skip and start_anyway record the skip; queue_one flags a catch-up", () => {
    expect(
      decideFire({ policy: "skip", launchability: "busy", capFull: false }),
    ).toEqual({ action: "skip", outcome: "skipped_task_busy" });
    expect(
      decideFire({
        policy: "start_anyway",
        launchability: "busy",
        capFull: false,
      }),
    ).toEqual({ action: "skip", outcome: "skipped_task_busy" });
    expect(
      decideFire({
        policy: "queue_one",
        launchability: "busy",
        capFull: false,
      }),
    ).toEqual({ action: "catchup", outcome: "catchup_queued" });
  });

  it("busy wins precedence over cap-full (start_anyway never queues a busy task)", () => {
    expect(
      decideFire({
        policy: "start_anyway",
        launchability: "busy",
        capFull: true,
      }),
    ).toEqual({ action: "skip", outcome: "skipped_task_busy" });
  });

  it("cap full on a launchable task: skip skips, queue_one flags, start_anyway launches", () => {
    expect(
      decideFire({
        policy: "skip",
        launchability: "launchable",
        capFull: true,
      }),
    ).toEqual({ action: "skip", outcome: "skipped_cap" });
    expect(
      decideFire({
        policy: "queue_one",
        launchability: "launchable",
        capFull: true,
      }),
    ).toEqual({ action: "catchup", outcome: "catchup_queued" });
    expect(
      decideFire({
        policy: "start_anyway",
        launchability: "launchable",
        capFull: true,
      }),
    ).toEqual({ action: "launch" });
  });

  it("free: every policy launches", () => {
    for (const policy of ["skip", "queue_one", "start_anyway"] as const) {
      expect(
        decideFire({ policy, launchability: "launchable", capFull: false }),
      ).toEqual({ action: "launch" });
    }
  });
});
