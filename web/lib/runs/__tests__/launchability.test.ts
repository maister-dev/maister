import type { RunStatus, TaskStatus } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { classifyTaskLaunchability } from "@/lib/runs/launchability";

// M28/T2.1 — the shared launch-gate classifier. `tasks.status` is a one-way
// latch (nothing writes Backlog back after launch), so the latest flow run
// decides relaunchability; terminal task statuses alone take precedence.

function task(status: TaskStatus): { status: TaskStatus } {
  return { status };
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
