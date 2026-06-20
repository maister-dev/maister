import type {
  BoardColumn,
  DeriveStageInput,
  RunStatus,
  TaskStage,
  TaskStatus,
} from "@/lib/board";

import { describe, expect, it } from "vitest";

import { BOARD_COLUMNS, columnLabelKey, deriveStage } from "@/lib/board";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function s(
  runStatus: RunStatus | null,
  opts: Partial<Omit<DeriveStageInput, "runStatus">> = {},
): DeriveStageInput {
  return {
    taskStatus: opts.taskStatus ?? "InFlight",
    taskStage: opts.taskStage ?? "Backlog",
    runStatus,
    workspaceRemoved: opts.workspaceRemoved ?? false,
  };
}

// ---------------------------------------------------------------------------
// No-run (pure task state)
// ---------------------------------------------------------------------------

describe("no run yet", () => {
  it("Backlog task → Backlog", () => {
    expect(
      deriveStage({
        taskStatus: "Backlog",
        taskStage: "Backlog",
        runStatus: null,
        workspaceRemoved: false,
      }),
    ).toBe("Backlog");
  });

  it("Prepare taskStage (no run) → Prepare", () => {
    expect(
      deriveStage({
        taskStatus: "Backlog",
        taskStage: "Prepare",
        runStatus: null,
        workspaceRemoved: false,
      }),
    ).toBe("Prepare");
  });

  it("InFlight task with no run → Backlog (task returned mid-flight, edge)", () => {
    expect(
      deriveStage({
        taskStatus: "InFlight",
        taskStage: "Backlog",
        runStatus: null,
        workspaceRemoved: false,
      }),
    ).toBe("Backlog");
  });

  it("Done task with no run → Done", () => {
    expect(
      deriveStage({
        taskStatus: "Done",
        taskStage: "Backlog",
        runStatus: null,
        workspaceRemoved: false,
      }),
    ).toBe("Done");
  });
});

// ---------------------------------------------------------------------------
// Prepare via run status
// ---------------------------------------------------------------------------

describe("Pending run → Prepare", () => {
  it("maps to Prepare", () => {
    expect(deriveStage(s("Pending"))).toBe("Prepare");
  });
});

// ---------------------------------------------------------------------------
// InProduction
// ---------------------------------------------------------------------------

describe("InProduction run statuses", () => {
  it("Running → InProduction", () => {
    expect(deriveStage(s("Running"))).toBe("InProduction");
  });

  it("NeedsInput → InProduction", () => {
    expect(deriveStage(s("NeedsInput"))).toBe("InProduction");
  });

  it("NeedsInputIdle → InProduction", () => {
    expect(deriveStage(s("NeedsInputIdle"))).toBe("InProduction");
  });

  // M11b (ADR-030): a claimed run is HumanWorking — a REAL run status that
  // stays in the in-flight bucket (treated like Running/NeedsInput for column
  // placement), not a normal running task visually.
  it("HumanWorking → InProduction (in-flight, manual takeover)", () => {
    expect(deriveStage(s("HumanWorking"))).toBe("InProduction");
  });

  // M37 (ADR-098): a parked orchestrator awaiting its children stays in-flight.
  it("WaitingOnChildren → InProduction (orchestrator parked on children)", () => {
    expect(deriveStage(s("WaitingOnChildren"))).toBe("InProduction");
  });
});

// ---------------------------------------------------------------------------
// OnReview
// ---------------------------------------------------------------------------

describe("Review run → OnReview", () => {
  it("maps to OnReview", () => {
    expect(deriveStage(s("Review"))).toBe("OnReview");
  });
});

// ---------------------------------------------------------------------------
// InDelivery vs Done (Done run, workspace presence)
// ---------------------------------------------------------------------------

describe("Done run — InDelivery vs Done", () => {
  it("Done run + workspace present → InDelivery", () => {
    expect(deriveStage(s("Done", { workspaceRemoved: false }))).toBe(
      "InDelivery",
    );
  });

  it("Done run + workspace removed → Done", () => {
    expect(deriveStage(s("Done", { workspaceRemoved: true }))).toBe("Done");
  });
});

// ---------------------------------------------------------------------------
// Crashed → its own column (M19); Failed / Abandoned → Backlog (retry rule)
// ---------------------------------------------------------------------------

describe("Crashed → Crashed; Failed/Abandoned → Backlog (retry rule)", () => {
  it("Crashed → Crashed", () => {
    expect(deriveStage(s("Crashed"))).toBe("Crashed");
  });

  it("Failed → Backlog", () => {
    expect(deriveStage(s("Failed"))).toBe("Backlog");
  });

  it("Abandoned → Backlog", () => {
    expect(deriveStage(s("Abandoned"))).toBe("Backlog");
  });

  it("Crashed overrides Prepare taskStage → Crashed wins", () => {
    expect(
      deriveStage({
        taskStatus: "InFlight",
        taskStage: "Prepare",
        runStatus: "Crashed",
        workspaceRemoved: false,
      }),
    ).toBe("Crashed");
  });
});

// ---------------------------------------------------------------------------
// Totality: iterate representative matrix
// ---------------------------------------------------------------------------

describe("totality — every combination returns a known column", () => {
  const taskStatuses: TaskStatus[] = [
    "Backlog",
    "InFlight",
    "Done",
    "Abandoned",
  ];
  const taskStages: TaskStage[] = ["Backlog", "Prepare"];
  const runStatuses: Array<RunStatus | null> = [
    null,
    "Pending",
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "HumanWorking",
    "WaitingOnChildren",
    "Review",
    "Crashed",
    "Done",
    "Abandoned",
    "Failed",
  ];
  const removedValues = [false, true];

  const validColumns = new Set<BoardColumn>(BOARD_COLUMNS);

  for (const taskStatus of taskStatuses) {
    for (const taskStage of taskStages) {
      for (const runStatus of runStatuses) {
        for (const workspaceRemoved of removedValues) {
          it(`[${taskStatus}/${taskStage}/${String(runStatus)}/${String(workspaceRemoved)}] → valid column`, () => {
            const result = deriveStage({
              taskStatus,
              taskStage,
              runStatus,
              workspaceRemoved,
            });

            expect(validColumns.has(result)).toBe(true);
          });
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// columnLabelKey
// ---------------------------------------------------------------------------

describe("columnLabelKey", () => {
  it("returns correct i18n keys for all columns", () => {
    expect(columnLabelKey("Backlog")).toBe("board.colBacklog");
    expect(columnLabelKey("Prepare")).toBe("board.colPrepare");
    expect(columnLabelKey("InProduction")).toBe("board.colProduction");
    expect(columnLabelKey("OnReview")).toBe("board.colReview");
    expect(columnLabelKey("InDelivery")).toBe("board.colDelivery");
    expect(columnLabelKey("Crashed")).toBe("board.colCrashed");
    expect(columnLabelKey("Done")).toBe("board.colDone");
  });

  it("covers all BOARD_COLUMNS entries", () => {
    for (const col of BOARD_COLUMNS) {
      expect(columnLabelKey(col)).toMatch(/^board\./);
    }
  });
});
