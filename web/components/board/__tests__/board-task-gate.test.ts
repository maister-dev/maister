import { describe, expect, it } from "vitest";

import { boardTaskGate } from "@/components/board/board-task-gate";
import {
  classifyForceRelaunchLaunchability,
  classifyManualTaskLaunchability,
} from "@/lib/runs/launchability";

describe("board task gate parity", () => {
  it("treats qualification findings as advisory while preserving independent holds and execution protections", () => {
    for (const triageFlagOrigin of [
      "qualification",
      "explicit",
      "dispatch_failure",
      "unknown",
    ] as const) {
      const task = {
        status: "Backlog" as const,
        triageStatus: "flagged" as const,
        triageFlagOrigin,
      };
      const expected =
        triageFlagOrigin === "qualification" ? "launchable" : "flagged";

      expect(
        classifyManualTaskLaunchability(task, null, undefined, {
          openBlocking: 0,
        }),
      ).toBe(expected);
      expect(
        classifyForceRelaunchLaunchability(task, null, undefined, {
          openBlocking: 0,
        }),
      ).toBe(expected);
      expect(
        boardTaskGate({
          ...task,
          clarificationPending: false,
          blockedByCount: 0,
        }),
      ).toBe(expected);
    }
    const assessed = {
      status: "Backlog" as const,
      triageStatus: "flagged" as const,
      triageFlagOrigin: "qualification" as const,
    };

    expect(
      classifyManualTaskLaunchability(
        { ...assessed, queuePaused: true },
        null,
        undefined,
        { openBlocking: 0 },
      ),
    ).toBe("queue_paused");
    expect(
      classifyManualTaskLaunchability(assessed, null, undefined, {
        openBlocking: 1,
      }),
    ).toBe("clarification_pending");
    expect(
      classifyManualTaskLaunchability(
        assessed,
        null,
        { openBlockers: [{ key: "MAI", number: 1 }] },
        { openBlocking: 0 },
      ),
    ).toBe("blocked");
  });
  it("matches manual and force relaunch task gates for all flag and hold combinations", () => {
    for (const triageStatus of [null, "triaged", "flagged"] as const) {
      for (const clarificationPending of [false, true]) {
        for (const blockedByCount of [0, 1]) {
          const board = boardTaskGate({
            triageStatus,
            clarificationPending,
            blockedByCount,
          });
          const task = { status: "Backlog" as const, triageStatus };
          const relationGate = {
            openBlockers: blockedByCount > 0 ? [{ key: "MAI", number: 1 }] : [],
          };
          const clarificationGate = {
            openBlocking: Number(clarificationPending),
          };

          expect(board).toBe(
            classifyManualTaskLaunchability(
              task,
              null,
              relationGate,
              clarificationGate,
            ),
          );
          expect(board).toBe(
            classifyForceRelaunchLaunchability(
              task,
              null,
              relationGate,
              clarificationGate,
            ),
          );
        }
      }
    }
  });
});
