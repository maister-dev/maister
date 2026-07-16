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
    requestedAt: null,
    aggregate: {
      displayTotal: 4.2,
      perCriterion: [{ criterionId: "correctness", displayValue: 4.5 }],
      warnings: [],
    },
  },
];

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
