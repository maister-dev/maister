import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";
import {
  WORK_STAGES,
  deriveWorkStage,
  type DeriveWorkStageInput,
  type WorkStage,
} from "@/lib/work/stage";

const TASK_STATUSES = ["Backlog", "InFlight", "Done", "Abandoned"] as const;
const TRIAGE_STATUSES = [null, "triaged", "flagged"] as const;
const PROMOTION_STATES = [
  "none",
  "claiming",
  "done",
  "failed",
  "reopened",
] as const;

function input(over: Partial<DeriveWorkStageInput> = {}): DeriveWorkStageInput {
  return {
    taskStatus: "InFlight",
    taskStage: "Backlog",
    triageStatus: null,
    runStatus: "Running",
    runKind: "flow",
    promotionState: "none",
    workspaceRemoved: false,
    blockingRelationCount: 0,
    progress: null,
    ...over,
  };
}

const STAGE_SET = new Set<string>(WORK_STAGES);

describe("UT-STG-01 deriveWorkStage is total", () => {
  it("returns a defined WorkStage for every cell of the full cross-product", () => {
    const undefinedCells: string[] = [];
    let cells = 0;

    for (const runStatus of [...RUN_STATUS_VALUES, null]) {
      for (const taskStatus of TASK_STATUSES) {
        for (const triageStatus of TRIAGE_STATUSES) {
          for (const blockingRelationCount of [0, 2]) {
            for (const workspaceRemoved of [false, true]) {
              for (const promotionState of PROMOTION_STATES) {
                cells += 1;
                const result = deriveWorkStage(
                  input({
                    runStatus,
                    taskStatus,
                    triageStatus,
                    blockingRelationCount,
                    workspaceRemoved,
                    promotionState,
                  }),
                );

                if (!STAGE_SET.has(result.stage as string)) {
                  undefinedCells.push(
                    `${runStatus ?? "no-run"}/${taskStatus}/${triageStatus ?? "untriaged"}/` +
                      `blocked=${blockingRelationCount > 0}/removed=${workspaceRemoved}/${promotionState}`,
                  );
                }
              }
            }
          }
        }
      }
    }

    expect(cells).toBe(
      (RUN_STATUS_VALUES.length + 1) *
        TASK_STATUSES.length *
        TRIAGE_STATUSES.length *
        2 *
        2 *
        PROMOTION_STATES.length,
    );
    expect(undefinedCells).toEqual([]);
  });

  it("maps every run status to a stage, so a twelfth status cannot slip through", () => {
    const unmapped = RUN_STATUS_VALUES.filter(
      (runStatus) =>
        !STAGE_SET.has(deriveWorkStage(input({ runStatus })).stage),
    );

    expect(unmapped).toEqual([]);
  });
});

describe("UT-STG-02 deriveWorkStage is pure", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "stage.ts"),
    "utf8",
  );

  it("imports no server-only marker, no database handle and no clock", () => {
    expect(source).not.toMatch(/["']server-only["']/);
    expect(source).not.toMatch(/\bgetDb\b|drizzle|@\/lib\/db\/client/);
    expect(source).not.toMatch(/new Date\(|Date\.now\(/);
  });

  it("returns the same result for the same input", () => {
    const first = deriveWorkStage(input({ runStatus: "Review" }));
    const second = deriveWorkStage(input({ runStatus: "Review" }));

    expect(first).toEqual(second);
  });
});

describe("UT-STG-03 result-only completion is Promoted, not Executing or Review", () => {
  it("maps Done with promotion_state none to Promoted/result", () => {
    const result = deriveWorkStage(
      input({ runStatus: "Done", promotionState: "none" }),
    );

    expect(result.stage).toBe<WorkStage>("Promoted");
    expect(result.promotedKind).toBe("result");
  });

  it("maps Done with promotion_state done to Promoted/merge", () => {
    const result = deriveWorkStage(
      input({ runStatus: "Done", promotionState: "done" }),
    );

    expect(result.stage).toBe<WorkStage>("Promoted");
    expect(result.promotedKind).toBe("merge");
  });

  it("keeps promotedKind total over the three unreachable promotion states", () => {
    for (const promotionState of ["claiming", "failed", "reopened"] as const) {
      const result = deriveWorkStage(
        input({ runStatus: "Done", promotionState }),
      );

      expect(result.stage).toBe<WorkStage>("Promoted");
      expect(result.promotedKind).toBe("merge");
    }
  });

  it("reports no promotedKind for a run that has not finished", () => {
    expect(
      deriveWorkStage(input({ runStatus: "Running" })).promotedKind,
    ).toBeNull();
  });
});

describe("UT-STG-04 Failed relaunches, Crashed owes a decision", () => {
  it("maps Failed to Ready", () => {
    expect(
      deriveWorkStage(input({ runStatus: "Failed" })).stage,
    ).toBe<WorkStage>("Ready");
  });

  it("maps Crashed to Crashed", () => {
    expect(
      deriveWorkStage(input({ runStatus: "Crashed" })).stage,
    ).toBe<WorkStage>("Crashed");
  });

  it("maps Abandoned to Abandoned, not Ready", () => {
    expect(
      deriveWorkStage(input({ runStatus: "Abandoned" })).stage,
    ).toBe<WorkStage>("Abandoned");
  });
});

describe("UT-STG-05 blocked is an attribute, never a stage", () => {
  it("is absent from the WorkStage vocabulary", () => {
    expect(STAGE_SET.has("Blocked")).toBe(false);
    expect(STAGE_SET.has("blocked")).toBe(false);
  });

  it("keeps the real stage while flagging the blocker", () => {
    const result = deriveWorkStage(
      input({
        runStatus: null,
        triageStatus: "triaged",
        blockingRelationCount: 3,
      }),
    );

    expect(result.stage).toBe<WorkStage>("Ready");
    expect(result.blocked).toBe(true);
  });

  it("does not change the stage a task would otherwise have", () => {
    const free = deriveWorkStage(input({ blockingRelationCount: 0 }));
    const held = deriveWorkStage(input({ blockingRelationCount: 5 }));

    expect(held.stage).toBe(free.stage);
    expect(free.blocked).toBe(false);
  });
});

describe("UT-STG-06 unreachable members are not in the vocabulary", () => {
  it("omits Intake and Delivered until their milestones ship", () => {
    expect(STAGE_SET.has("Intake")).toBe(false);
    expect(STAGE_SET.has("Delivered")).toBe(false);
  });

  it("declares exactly the ten reachable members", () => {
    expect([...WORK_STAGES].sort()).toEqual(
      [
        "Abandoned",
        "Crashed",
        "Executing",
        "Held",
        "Promoted",
        "Queued",
        "Ready",
        "Review",
        "Triage",
        "WaitingOnHuman",
      ].sort(),
    );
  });
});

describe("UT-EDGE-STG-02 a removed workspace returns a parked run to a relaunchable lane", () => {
  it("reroutes Review and Crashed to Ready", () => {
    for (const runStatus of ["Review", "Crashed"] as const) {
      expect(
        deriveWorkStage(input({ runStatus, workspaceRemoved: true })).stage,
      ).toBe<WorkStage>("Ready");
    }
  });

  it("leaves every other run status alone", () => {
    expect(
      deriveWorkStage(input({ runStatus: "Running", workspaceRemoved: true }))
        .stage,
    ).toBe<WorkStage>("Executing");
    expect(
      deriveWorkStage(
        input({
          runStatus: "Done",
          promotionState: "done",
          workspaceRemoved: true,
        }),
      ).stage,
    ).toBe<WorkStage>("Promoted");
  });
});

describe("UT-EDGE-STG-03 a task with no run classifies from triage alone", () => {
  it("maps the three triage states", () => {
    const cases: Array<[DeriveWorkStageInput["triageStatus"], WorkStage]> = [
      [null, "Triage"],
      ["flagged", "Held"],
      ["triaged", "Ready"],
    ];

    for (const [triageStatus, stage] of cases) {
      expect(
        deriveWorkStage(input({ runStatus: null, triageStatus })).stage,
      ).toBe(stage);
    }
  });

  it("carries no progress and no promotedKind", () => {
    const result = deriveWorkStage(
      input({
        runStatus: null,
        triageStatus: null,
        progress: { done: 2, total: 5 },
      }),
    );

    expect(result.progress).toBeNull();
    expect(result.promotedKind).toBeNull();
  });
});

describe("progress rides only an executing run", () => {
  it("carries k/N while Executing", () => {
    expect(
      deriveWorkStage(
        input({ runStatus: "Running", progress: { done: 2, total: 5 } }),
      ).progress,
    ).toEqual({ done: 2, total: 5 });
  });

  it("drops it once the run is no longer executing", () => {
    expect(
      deriveWorkStage(
        input({ runStatus: "Review", progress: { done: 5, total: 5 } }),
      ).progress,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UT-STG-12 — a terminal task with no run is settled, not backlog.
//
// `abandonUnlaunchedTasks` (the orchestrator cascade) sets `Abandoned` with
// `notExists(runs for this task)` in its WHERE, so a run-LESS terminal task is
// the ONLY shape that path produces. Classifying the no-run case from
// `triageStatus` alone rendered those rows as live work with working
// next-action links, and hid them from the `Abandoned` filter.
// ---------------------------------------------------------------------------
describe("UT-STG-12 terminal task status wins over triage when no run exists", () => {
  const base = {
    taskStage: "Backlog" as const,
    runStatus: null,
    runKind: null,
    promotionState: null,
    workspaceRemoved: false,
    blockingRelationCount: 0,
    progress: null,
  };

  it("classifies a cascade-abandoned, never-launched task as Abandoned", () => {
    expect(
      deriveWorkStage({
        ...base,
        taskStatus: "Abandoned",
        triageStatus: "triaged",
      }).stage,
    ).toBe("Abandoned");
  });

  it("does not let a flagged triage state resurrect an abandoned task", () => {
    // The dangerous pair: triage says Held, the task is over. Held is a
    // decision-queue stage, so getting this wrong also invents an attention
    // item for work nobody can act on.
    expect(
      deriveWorkStage({
        ...base,
        taskStatus: "Abandoned",
        triageStatus: "flagged",
      }).stage,
    ).toBe("Abandoned");
  });

  it("classifies a run-less Done task as settled rather than Triage", () => {
    expect(
      deriveWorkStage({
        ...base,
        taskStatus: "Done",
        triageStatus: null,
      }).stage,
    ).toBe("Promoted");
  });

  it("still reads a LIVE task from triage, which is the no-run default", () => {
    for (const [triage, stage] of [
      [null, "Triage"],
      ["flagged", "Held"],
      ["triaged", "Ready"],
    ] as const) {
      expect(
        deriveWorkStage({
          ...base,
          taskStatus: "Backlog",
          triageStatus: triage,
        }).stage,
      ).toBe(stage);
    }
  });

  it("never lets a terminal task status override a live run", () => {
    // The run axis still dominates when a run exists — an InFlight task whose
    // run is Running is Executing, and a terminal task status cannot reach it.
    expect(
      deriveWorkStage({
        ...base,
        taskStatus: "Abandoned",
        triageStatus: "triaged",
        runStatus: "Running",
      }).stage,
    ).toBe("Executing");
  });
});
