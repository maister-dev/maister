import type { ExperimentComparisonDTO } from "@/lib/experiments/comparison";
import type { ExperimentLabLabels } from "@/components/experiments/experiment-lab";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExperimentLab } from "@/components/experiments/experiment-lab";

const navigationMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigationMocks,
}));

const labels: ExperimentLabLabels = {
  eyebrow: "Experiment lab",
  task: "Task",
  base: "Pinned base",
  branch: "Base branch",
  launch: "Launch",
  abandon: "Abandon",
  conclude: "Conclude",
  launchVariants: "Launch variants",
  launchReplicates: "Replicates",
  variants: "Variants",
  latestReplicate: "Latest replicate",
  queuePosition: "Queue",
  duration: "Duration",
  openRun: "Open run",
  noRuns: "No runs yet",
  crashedConcludable: "Crashed variants remain comparable",
  tabs: {
    diff: "Diff",
    diffOfDiffs: "Diff of diffs",
    files: "Files",
    gates: "Gates",
    cost: "Cost",
    verdict: "Verdict",
  },
  status: {
    draft: "Draft",
    running: "Running",
    comparable: "Comparable",
    concluded: "Concluded",
    abandoned: "Abandoned",
  },
  runStatus: {
    Pending: "Pending",
    Running: "Running",
    NeedsInput: "Needs input",
    NeedsInputIdle: "Needs input idle",
    HumanWorking: "Human working",
    WaitingOnChildren: "Waiting on children",
    Review: "Review",
    Crashed: "Crashed",
    Done: "Done",
    Abandoned: "Abandoned",
    Failed: "Failed",
  },
};

function comparison(
  status: ExperimentComparisonDTO["experiment"]["status"],
): ExperimentComparisonDTO {
  return {
    experiment: {
      id: `exp-${status}`,
      projectId: "project-1",
      taskId: "task-1",
      title: `${status} experiment`,
      description: null,
      status,
      baseBranch: "main",
      baseCommit: "abcdef1234567890",
      variants: [
        { key: "a", label: "Control", config: {} },
        { key: "b", label: "Candidate", config: {} },
      ],
      rubric: {
        criteria: [
          {
            id: "correctness",
            label: "Correctness",
            guidance: "Works",
            scale: { min: 1, max: 5 },
            weight: 1,
          },
        ],
      },
      verdict: null,
      createdAt: "2026-07-03T08:00:00.000Z",
      launchedAt: null,
      comparableAt: null,
      concludedAt: null,
      abandonedAt: null,
    },
    variants: [
      { key: "a", label: "Control", config: {} },
      { key: "b", label: "Candidate", config: {} },
    ],
    runs: [
      {
        runId: "run-a-1",
        variantKey: "a",
        replicateOrdinal: 1,
        launchReason: "initial",
        status: status === "draft" ? "Pending" : "Review",
        statusTone: "review",
        durationMs: 90_000,
        queuePosition: null,
        runnerLabels: ["claude"],
        gates: [],
        cost: { hasData: false },
        diff: {
          snapshot: "diff --git a/a.ts b/a.ts",
          truncated: false,
          bytes: 120,
          capturedAt: "2026-07-03T09:00:00.000Z",
        },
        files: [],
        materializationDelta: null,
      },
      {
        runId: "run-b-1",
        variantKey: "b",
        replicateOrdinal: 1,
        launchReason: "initial",
        status: status === "comparable" ? "Crashed" : "Pending",
        statusTone: status === "comparable" ? "crashed" : "pending",
        durationMs: null,
        queuePosition: 3,
        runnerLabels: ["codex"],
        gates: [],
        cost: { hasData: false },
        diff: {
          snapshot: null,
          truncated: false,
          bytes: null,
          capturedAt: null,
        },
        files: [],
        materializationDelta: null,
      },
    ],
    verdict: null,
    generatedAt: "2026-07-03T09:01:00.000Z",
  };
}

function render(status: ExperimentComparisonDTO["experiment"]["status"]): string {
  return renderToStaticMarkup(
    createElement(ExperimentLab, {
      comparison: comparison(status),
      labels,
      canManage: true,
      canConclude: true,
      projectSlug: "proj",
      taskKeyPrefix: "KEY",
      taskNumber: 12,
      judgeAvailable: true,
    }),
  );
}

describe("ExperimentLab", () => {
  it("renders all FSM states with pinned base and action affordances", () => {
    for (const status of [
      "draft",
      "running",
      "comparable",
      "concluded",
      "abandoned",
    ] as const) {
      const html = render(status);

      expect(html).toContain(labels.status[status]);
      expect(html).toContain("abcdef1");
      expect(html).toContain("main");
      expect(html).toContain("Launch");
    }
  });

  it("renders pending queue position, crashed member, duration, and run links", () => {
    const html = render("comparable");

    expect(html).toContain("Queue #3");
    expect(html).toContain("Crashed");
    expect(html).toContain("1m 30s");
    expect(html).toContain("/runs/run-a-1");
    expect(html).toContain("Crashed variants remain comparable");
    expect(html).toContain("Conclude");
  });

  it("uses localized labels supplied by the page", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentLab, {
        comparison: comparison("running"),
        labels: {
          ...labels,
          eyebrow: "Лаборатория",
          launch: "Запустить",
      status: { ...labels.status, running: "В работе" },
      launchVariants: "Варианты запуска",
      launchReplicates: "Повторы",
    },
        canManage: true,
        canConclude: false,
        projectSlug: "proj",
        taskKeyPrefix: "KEY",
        taskNumber: 12,
        judgeAvailable: false,
      }),
    );

    expect(html).toContain("Лаборатория");
    expect(html).toContain("Запустить");
    expect(html).toContain("В работе");
  });

  it("renders launch variant and replicate controls instead of hardcoding all x1", () => {
    const html = render("draft");

    expect(html).toContain("Launch variants");
    expect(html).toContain('name="replicates"');
    expect(html).toContain('value="a"');
    expect(html).toContain('value="b"');
  });
});
