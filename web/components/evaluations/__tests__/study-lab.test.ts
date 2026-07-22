import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/projects/p/evaluations",
}));

import {
  buildVerdictPayload,
  citedPartialWarnings,
  StudyLab,
  type ExecutionView,
  type ParticipantView,
} from "@/components/evaluations/study-lab";
import {
  StudyList,
  type StudySummary,
  type TaskOption,
} from "@/components/evaluations/study-list";

const participants: ParticipantView[] = [
  {
    id: "p1",
    label: "Run A",
    sourceType: "observed",
    runId: "r1",
    runStatus: "Done",
  },
  {
    id: "p2",
    label: "Run B",
    sourceType: "observed",
    runId: "r2",
    runStatus: "Failed",
  },
];

const executions: ExecutionView[] = [
  {
    id: "e1",
    status: "completed",
    terminalReason: null,
    methodQualifiedId: "core:sdd-quality",
    aggregate: {
      displayTotal: 4.2,
      perCriterion: [{ criterionId: "correctness", displayValue: 4.5 }],
      warnings: [],
    },
    tournament: null,
  },
];

const partialExecution: ExecutionView = {
  id: "e2",
  status: "partial",
  terminalReason: null,
  methodQualifiedId: "core:sdd-quality",
  aggregate: {
    displayTotal: 3.1,
    perCriterion: [],
    warnings: ["incomplete_coverage"],
  },
  tournament: null,
};

const controlledLaunch = {
  enabled: true,
  launchable: true,
  taskId: "t1",
  scaffold: null,
  runnerOptions: [],
  overlayCatalog: { rules: [], skills: [], mcps: [], subagents: [] },
  existingRecipes: [],
};

describe("StudyLab", () => {
  it("renders participants, the scoreboard, and manage actions for a member", () => {
    const markup = renderToStaticMarkup(
      createElement(StudyLab, {
        slug: "p",
        study: { id: "s1", title: "My Study", status: "open", version: 1 },
        participants,
        executions,
        profiles: [{ id: "pr1", name: "SDD Profile" }],
        comparableRuns: [{ id: "r3", status: "Done" }],
        verdicts: [],
        controlledLaunch,
        canStandardize: false,
        canManage: true,
        canConclude: true,
      }),
    );

    expect(markup).toContain("My Study");
    expect(markup).toContain("Run A");
    expect(markup).toContain("core:sdd-quality");
    expect(markup).toContain("4.2");
    expect(markup).toContain("startEvaluation");
    expect(markup).toContain("humanVerdict");
    // An addable comparable run (not already a participant) is offered.
    expect(markup).toContain("addObserved");
    // Run statuses are translated through the run.runStatus namespace, never raw.
    expect(markup).toContain("runStatus.Done");
    expect(markup).toContain("runStatus.Failed");
  });

  it("renders the winner participant picker for the default winner outcome", () => {
    const markup = renderToStaticMarkup(
      createElement(StudyLab, {
        slug: "p",
        study: { id: "s1", title: "My Study", status: "open", version: 1 },
        participants,
        executions,
        profiles: [{ id: "pr1", name: "SDD Profile" }],
        comparableRuns: [],
        verdicts: [],
        controlledLaunch,
        canStandardize: false,
        canManage: true,
        canConclude: true,
      }),
    );

    expect(markup).toContain("winnerParticipant");
    expect(markup).toContain('type="radio"');
    // Nothing is cited on the initial render, so no partial acknowledgement yet.
    expect(markup).not.toContain("partialAck");
  });

  it("marks a failed execution with the danger tone and its terminal reason", () => {
    const markup = renderToStaticMarkup(
      createElement(StudyLab, {
        slug: "p",
        study: { id: "s1", title: "My Study", status: "open", version: 1 },
        participants,
        executions: [
          {
            id: "e9",
            status: "failed",
            terminalReason: "capture_failed",
            methodQualifiedId: "core:sdd-quality",
            aggregate: null,
            tournament: null,
          },
        ],
        profiles: [],
        comparableRuns: [],
        verdicts: [],
        controlledLaunch,
        canStandardize: false,
        canManage: false,
        canConclude: false,
      }),
    );

    expect(markup).toContain("text-danger");
    expect(markup).toContain("terminalReason");
    expect(markup).toContain("capture_failed");
  });

  it("hides manage/verdict actions for a viewer", () => {
    const markup = renderToStaticMarkup(
      createElement(StudyLab, {
        slug: "p",
        study: { id: "s1", title: "My Study", status: "open", version: 1 },
        participants,
        executions,
        profiles: [{ id: "pr1", name: "SDD Profile" }],
        comparableRuns: [],
        verdicts: [{ id: "v1", outcome: "winner", createdAt: null }],
        controlledLaunch,
        canStandardize: false,
        canManage: false,
        canConclude: false,
      }),
    );

    expect(markup).not.toContain("startEvaluation");
    expect(markup).not.toContain("recordVerdict");
    // A concluded verdict is still shown read-only.
    expect(markup).toContain("outcome_winner");
  });
});

describe("citedPartialWarnings", () => {
  it("requires acknowledgement and lists warnings when a partial execution is cited", () => {
    const result = citedPartialWarnings(
      [...executions, partialExecution],
      new Set(["e2"]),
    );

    expect(result.hasCitedPartial).toBe(true);
    expect(result.warnings).toEqual(["incomplete_coverage"]);
  });

  it("requires nothing when only completed executions are cited", () => {
    const result = citedPartialWarnings(
      [...executions, partialExecution],
      new Set(["e1"]),
    );

    expect(result.hasCitedPartial).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});

describe("buildVerdictPayload", () => {
  it("sends the acknowledged comparability warnings when a partial is cited", () => {
    const payload = buildVerdictPayload({
      outcome: "winner",
      executions: [...executions, partialExecution],
      citedIds: new Set(["e2"]),
      winnerId: "p1",
      zeroCitationAck: false,
      rationale: "",
    });

    expect(payload.acknowledgedWarnings).toEqual(["incomplete_coverage"]);
    expect(payload.participantIds).toEqual(["p1"]);
    expect(payload.noEvaluationEvidenceAck).toBeUndefined();
  });

  it("still sends a non-empty acknowledgement when the cited partial lists no warnings", () => {
    const bare: ExecutionView = { ...partialExecution, aggregate: null };
    const payload = buildVerdictPayload({
      outcome: "tie",
      executions: [bare],
      citedIds: new Set(["e2"]),
      winnerId: "",
      zeroCitationAck: false,
      rationale: "",
    });

    expect(payload.acknowledgedWarnings).toEqual(["partial"]);
    expect(payload.participantIds).toEqual([]);
  });

  it("omits acknowledgements and carries the zero-citation ack when nothing is cited", () => {
    const payload = buildVerdictPayload({
      outcome: "inconclusive",
      executions,
      citedIds: new Set(),
      winnerId: "",
      zeroCitationAck: true,
      rationale: "  why  ",
    });

    expect(payload.acknowledgedWarnings).toBeUndefined();
    expect(payload.noEvaluationEvidenceAck).toBe(true);
    expect(payload.rationale).toBe("why");
  });
});

describe("StudyList", () => {
  it("renders studies with a migrated badge and a create action for a manager", () => {
    const studies: StudySummary[] = [
      {
        id: "s1",
        title: "Legacy Study",
        status: "decided",
        taskId: "t1",
        updatedAt: null,
        legacyExperimentId: "exp-1",
      },
    ];
    const tasks: TaskOption[] = [{ id: "t1", title: "Fix bug", number: 3 }];

    const markup = renderToStaticMarkup(
      createElement(StudyList, {
        slug: "p",
        studies,
        tasks,
        canManage: true,
      }),
    );

    expect(markup).toContain("Legacy Study");
    expect(markup).toContain("migratedBadge");
    expect(markup).toContain("newStudy");
    expect(markup).toContain("status_decided");
  });

  it("renders an empty state and no create action for a viewer", () => {
    const markup = renderToStaticMarkup(
      createElement(StudyList, {
        slug: "p",
        studies: [],
        tasks: [],
        canManage: false,
      }),
    );

    expect(markup).toContain("noStudies");
    expect(markup).not.toContain("newStudy");
  });
});
