import type { ExperimentComparisonDTO } from "@/lib/experiments/comparison";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  JudgePanel,
  VerdictPanel,
  type JudgePanelLabels,
  type VerdictPanelLabels,
} from "@/components/experiments/verdict-panel";

const navigationMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigationMocks,
}));

const verdictLabels: VerdictPanelLabels = {
  title: "Human verdict",
  readOnly: "Verdict is locked",
  viewerReadOnly: "Viewer access",
  outcome: "Outcome",
  outcomeWinner: "Winner",
  outcomeTie: "Tie",
  outcomeInconclusive: "Inconclusive",
  winner: "Winner variant",
  comment: "Comment",
  abandonLosers: "Abandon losers",
  submit: "Conclude",
  score: "Score",
  skipOptional: "Skip optional",
  optional: "optional",
  required: "required",
  validationError: "Resolve rubric scores before concluding",
  advisory: "Judge advisory",
  confidence: "Confidence",
  noAdvisory: "No advisory yet",
};

const judgeLabels: JudgePanelLabels = {
  title: "Experiment Judge",
  ask: "Ask judge",
  pending: "Judge is running",
  unavailable: "Attach Experiment Judge first",
  done: "Latest advisory",
  settings: "Open agents settings",
};

function comparison(over: Partial<ExperimentComparisonDTO> = {}): ExperimentComparisonDTO {
  return {
    experiment: {
      id: "exp-1",
      projectId: "project-1",
      taskId: "task-1",
      title: "Compare",
      description: null,
      status: "comparable",
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
            guidance: "Works as requested",
            scale: { min: 1, max: 5 },
            weight: 1,
          },
          {
            id: "specs_traceability",
            label: "Spec traceability",
            guidance: "Maps to specs",
            scale: { min: 1, max: 5 },
            weight: 1,
            optional: true,
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
    runs: [],
    verdict: null,
    generatedAt: "2026-07-03T09:00:00.000Z",
    ...over,
  };
}

describe("VerdictPanel", () => {
  it("renders rubric-driven score inputs with optional skip and winner controls", () => {
    const html = renderToStaticMarkup(
      createElement(VerdictPanel, {
        comparison: comparison(),
        labels: verdictLabels,
        canConclude: true,
        projectSlug: "proj",
      }),
    );

    expect(html).toContain("Correctness");
    expect(html).toContain("Spec traceability");
    expect(html).toContain("optional");
    expect(html).toContain("Skip optional");
    expect(html).toContain("Control");
    expect(html).toContain("Candidate");
    expect(html).toContain("Abandon losers");
  });

  it("renders judge advisory scores beside the human form", () => {
    const base = comparison();
    const withAdvisory = {
      ...base,
      verdict: {
        judgeAdvisories: [
          {
            advisoryOrdinal: 1,
            agentRunId: "run-judge",
            createdAt: "2026-07-03T09:00:00.000Z",
            scores: { correctness: { a: 3, b: 5 } },
            summary: "Candidate is more complete.",
            confidence: 0.76,
          },
        ],
      },
      experiment: {
        ...base.experiment,
        verdict: {
          judgeAdvisories: [
            {
              advisoryOrdinal: 1,
              agentRunId: "run-judge",
              createdAt: "2026-07-03T09:00:00.000Z",
              scores: { correctness: { a: 3, b: 5 } },
              summary: "Candidate is more complete.",
              confidence: 0.76,
            },
          ],
        },
      },
    } satisfies ExperimentComparisonDTO;

    const html = renderToStaticMarkup(
      createElement(VerdictPanel, {
        comparison: withAdvisory,
        labels: verdictLabels,
        canConclude: true,
        projectSlug: "proj",
      }),
    );

    expect(html).toContain("Judge advisory");
    expect(html).toContain("Candidate is more complete.");
    expect(html).toContain("0.76");
    expect(html).toContain("b: 5");
  });

  it("renders permission-hidden and concluded read-only states", () => {
    const viewer = renderToStaticMarkup(
      createElement(VerdictPanel, {
        comparison: comparison(),
        labels: verdictLabels,
        canConclude: false,
        projectSlug: "proj",
      }),
    );
    const concluded = comparison();
    concluded.experiment.status = "concluded";
    concluded.verdict = {
      human: {
        outcome: "winner",
        winnerVariantKey: "b",
        comment: "Ship B.",
      },
    };
    concluded.experiment.verdict = concluded.verdict;
    const locked = renderToStaticMarkup(
      createElement(VerdictPanel, {
        comparison: concluded,
        labels: verdictLabels,
        canConclude: true,
        projectSlug: "proj",
      }),
    );

    expect(viewer).toContain("Viewer access");
    expect(viewer).not.toContain('data-testid="verdict-submit"');
    expect(locked).toContain("Verdict is locked");
    expect(locked).toContain("Ship B.");
    expect(locked).not.toContain('data-testid="verdict-submit"');
  });
});

describe("JudgePanel", () => {
  it("renders unavailable, pending, and ready states", () => {
    const unavailable = renderToStaticMarkup(
      createElement(JudgePanel, {
        labels: judgeLabels,
        projectSlug: "proj",
        experimentId: "exp-1",
        available: false,
        pending: false,
        latestSummary: null,
      }),
    );
    const pending = renderToStaticMarkup(
      createElement(JudgePanel, {
        labels: judgeLabels,
        projectSlug: "proj",
        experimentId: "exp-1",
        available: true,
        pending: true,
        latestSummary: null,
      }),
    );
    const ready = renderToStaticMarkup(
      createElement(JudgePanel, {
        labels: judgeLabels,
        projectSlug: "proj",
        experimentId: "exp-1",
        available: true,
        pending: false,
        latestSummary: "Latest says B wins.",
      }),
    );

    expect(unavailable).toContain("Attach Experiment Judge first");
    expect(unavailable).toContain("/projects/proj?tab=agents");
    expect(pending).toContain("Judge is running");
    expect(ready).toContain("Ask judge");
    expect(ready).toContain("Latest says B wins.");
  });
});
