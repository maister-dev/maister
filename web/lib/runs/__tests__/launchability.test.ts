import type { RunStatus, TaskStatus } from "@/lib/db/schema";
import type { RelationGate } from "@/lib/runs/launchability";

import { describe, expect, it } from "vitest";

import {
  classifyManualTaskLaunchability,
  classifyTaskLaunchability,
} from "@/lib/runs/launchability";

// M28/T2.1 — the shared launch-gate classifier. `tasks.status` is a one-way
// latch (nothing writes Backlog back after launch), so the latest flow run
// decides relaunchability; terminal task statuses alone take precedence.

function task(
  status: TaskStatus,
  flowId: string | null = "flow-1",
): { status: TaskStatus; flowId: string | null } {
  return { status, flowId };
}

function run(status: RunStatus): { status: RunStatus } {
  return { status };
}

describe("classifyTaskLaunchability — terminal task statuses take precedence", () => {
  it("task Done with no run → target_terminal", () => {
    expect(classifyTaskLaunchability(task("Done"), null)).toBe(
      "target_terminal",
    );
  });

  it("task Abandoned with no run → target_terminal", () => {
    expect(classifyTaskLaunchability(task("Abandoned"), null)).toBe(
      "target_terminal",
    );
  });

  it("task Done with an active latest run → target_terminal (run row does NOT override)", () => {
    expect(classifyTaskLaunchability(task("Done"), run("Running"))).toBe(
      "target_terminal",
    );
  });

  it("task Abandoned with a retryable latest run → target_terminal", () => {
    expect(classifyTaskLaunchability(task("Abandoned"), run("Failed"))).toBe(
      "target_terminal",
    );
  });
});

describe("classifyTaskLaunchability — no latest flow run", () => {
  it("fresh Backlog task → launchable", () => {
    expect(classifyTaskLaunchability(task("Backlog"), null)).toBe("launchable");
  });

  it("InFlight task with no run (anomalous remnant) → busy", () => {
    expect(classifyTaskLaunchability(task("InFlight"), null)).toBe("busy");
  });
});

describe("classifyTaskLaunchability — latest flow run drives the verdict", () => {
  it.each<TaskStatus>(["Backlog", "InFlight"])(
    "latest run Failed (task %s) → launchable (board retry rule, attempt N+1)",
    (taskStatus) => {
      expect(classifyTaskLaunchability(task(taskStatus), run("Failed"))).toBe(
        "launchable",
      );
    },
  );

  it.each<TaskStatus>(["Backlog", "InFlight"])(
    "latest run Abandoned (task %s) → launchable",
    (taskStatus) => {
      expect(
        classifyTaskLaunchability(task(taskStatus), run("Abandoned")),
      ).toBe("launchable");
    },
  );

  it("latest run Crashed → crashed (owes recover/discard)", () => {
    expect(classifyTaskLaunchability(task("InFlight"), run("Crashed"))).toBe(
      "crashed",
    );
  });

  it("latest run Done → target_terminal", () => {
    expect(classifyTaskLaunchability(task("InFlight"), run("Done"))).toBe(
      "target_terminal",
    );
  });

  it.each<RunStatus>([
    "Pending",
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "HumanWorking",
    "Review",
  ])("latest run %s → busy", (runStatus) => {
    expect(classifyTaskLaunchability(task("InFlight"), run(runStatus))).toBe(
      "busy",
    );
  });
});

// ADR-078 D5 — relations gate LAUNCHING only, with precedence
// target_terminal > crashed > busy > blocked > launchable.
describe("classifyTaskLaunchability — relation gate (blocked)", () => {
  const gate: RelationGate = { openBlockers: [{ key: "MAI", number: 7 }] };
  const emptyGate: RelationGate = { openBlockers: [] };

  it("otherwise-launchable Backlog task with open blockers → blocked", () => {
    expect(classifyTaskLaunchability(task("Backlog"), null, gate)).toBe(
      "blocked",
    );
  });

  it("retry-eligible task (latest run Failed) with open blockers → blocked", () => {
    expect(
      classifyTaskLaunchability(task("Backlog"), run("Failed"), gate),
    ).toBe("blocked");
  });

  it("retry-eligible task (latest run Abandoned) with open blockers → blocked", () => {
    expect(
      classifyTaskLaunchability(task("InFlight"), run("Abandoned"), gate),
    ).toBe("blocked");
  });

  it("busy task with open blockers stays busy (blocked never masks run state)", () => {
    expect(
      classifyTaskLaunchability(task("InFlight"), run("Running"), gate),
    ).toBe("busy");
  });

  it("crashed task with open blockers stays crashed", () => {
    expect(
      classifyTaskLaunchability(task("InFlight"), run("Crashed"), gate),
    ).toBe("crashed");
  });

  it("terminal task with open blockers stays target_terminal", () => {
    expect(classifyTaskLaunchability(task("Done"), null, gate)).toBe(
      "target_terminal",
    );
    expect(classifyTaskLaunchability(task("InFlight"), run("Done"), gate)).toBe(
      "target_terminal",
    );
  });

  it("an empty gate never blocks", () => {
    expect(classifyTaskLaunchability(task("Backlog"), null, emptyGate)).toBe(
      "launchable",
    );
  });

  it("an omitted gate keeps the original two-arg behavior", () => {
    expect(classifyTaskLaunchability(task("Backlog"), null)).toBe("launchable");
  });
});

// M34 (ADR-089) — a flowless simple-intent task is `unconfigured`, with
// precedence target_terminal > crashed > busy > blocked > unconfigured >
// launchable.
describe("classifyTaskLaunchability — flowless task (unconfigured)", () => {
  const gate: RelationGate = { openBlockers: [{ key: "MAI", number: 7 }] };

  it("otherwise-launchable Backlog task without a flow → unconfigured", () => {
    expect(classifyTaskLaunchability(task("Backlog", null), null)).toBe(
      "unconfigured",
    );
  });

  it("retry-eligible flowless task (latest run Failed) → unconfigured", () => {
    expect(
      classifyTaskLaunchability(task("Backlog", null), run("Failed")),
    ).toBe("unconfigured");
  });

  it("blocked wins over unconfigured", () => {
    expect(classifyTaskLaunchability(task("Backlog", null), null, gate)).toBe(
      "blocked",
    );
  });

  it("busy flowless task stays busy (unconfigured never masks run state)", () => {
    expect(
      classifyTaskLaunchability(task("InFlight", null), run("Running")),
    ).toBe("busy");
  });

  it("crashed flowless task stays crashed", () => {
    expect(
      classifyTaskLaunchability(task("InFlight", null), run("Crashed")),
    ).toBe("crashed");
  });

  it("terminal flowless task stays target_terminal", () => {
    expect(classifyTaskLaunchability(task("Done", null), null)).toBe(
      "target_terminal",
    );
  });
});

describe("classifyManualTaskLaunchability — ADR-085 manual relaunch allow-list", () => {
  it.each<TaskStatus>(["Done", "Abandoned"])(
    "task %s with no latest run is manually launchable",
    (taskStatus) => {
      expect(classifyManualTaskLaunchability(task(taskStatus), null)).toBe(
        "launchable",
      );
    },
  );

  it.each<RunStatus>(["Done", "Review", "Failed", "Abandoned", "Crashed"])(
    "latest run %s is manually launchable",
    (runStatus) => {
      expect(
        classifyManualTaskLaunchability(task("InFlight"), run(runStatus)),
      ).toBe("launchable");
    },
  );

  it.each<RunStatus>([
    "Pending",
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "HumanWorking",
  ])("latest active run %s stays busy for manual relaunch", (runStatus) => {
    expect(
      classifyManualTaskLaunchability(task("InFlight"), run(runStatus)),
    ).toBe("busy");
  });

  it("relations still block an otherwise manual-launchable task", () => {
    expect(
      classifyManualTaskLaunchability(task("Done"), null, {
        openBlockers: [{ key: "MAI", number: 7 }],
      }),
    ).toBe("blocked");
  });
});
