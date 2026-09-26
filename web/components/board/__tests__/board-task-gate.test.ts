import { describe, expect, it } from "vitest";

import { boardTaskGate } from "@/components/board/board-task-gate";
import {
  classifyForceRelaunchLaunchability,
  classifyManualTaskLaunchability,
} from "@/lib/runs/launchability";

describe("board task gate parity", () => {
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
