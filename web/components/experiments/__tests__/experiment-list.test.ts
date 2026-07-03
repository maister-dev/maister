import type { ExperimentListItemDTO } from "@/lib/experiments/dto";
import type { ExperimentRubric, ExperimentVariant } from "@/lib/experiments/types";
import type { TaskDTO } from "@/lib/services/tasks";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CreateExperimentForm,
  ExperimentList,
  type CreateExperimentLabels,
  type ExperimentListLabels,
} from "@/components/experiments/experiment-list";

const listLabels: ExperimentListLabels = {
  title: "Experiments",
  subtitle: "Compare variants from one pinned base commit.",
  empty: "No experiments yet",
  errorTitle: "Experiment list failed",
  create: "New experiment",
  columns: {
    title: "Title",
    task: "Task",
    status: "Status",
    variants: "Variants",
    base: "Pinned base",
    created: "Created",
    verdict: "Verdict",
  },
  verdictPending: "No verdict",
  winner: "Winner",
  outcome: {
    winner: "Winner",
    tie: "Tie",
    inconclusive: "Inconclusive",
  },
  status: {
    draft: "Draft",
    running: "Running",
    comparable: "Comparable",
    concluded: "Concluded",
    abandoned: "Abandoned",
  },
};

const createLabels: CreateExperimentLabels = {
  trigger: "New experiment",
  title: "Create experiment",
  close: "Close",
  experimentTitle: "Experiment title",
  experimentDescription: "Description",
  taskMode: "Task source",
  existingTask: "Existing task",
  newTask: "Create task inline",
  task: "Task",
  taskTitle: "Task title",
  taskPrompt: "Task prompt",
  baseBranch: "Base branch",
  baseRef: "Explicit ref",
  variants: "Variants",
  variantKey: "Key",
  variantLabel: "Label",
  runner: "Runner override",
  executionPolicy: "Execution policy JSON",
  rulesAdd: "Rules add",
  rulesRemove: "Rules remove",
  skillsAdd: "Skills add",
  skillsRemove: "Skills remove",
  mcpsAdd: "MCPs add",
  mcpsRemove: "MCPs remove",
  subagentsAdd: "Subagents add",
  subagentsRemove: "Subagents remove",
  rubric: "Rubric",
  optional: "optional",
  create: "Create",
  creating: "Creating",
  cancel: "Cancel",
  errorGeneric: "Request failed",
  validationRequired: "Required",
};

const experiments: ExperimentListItemDTO[] = [
  {
    id: "exp-1",
    title: "Two runner comparison",
    taskId: "task-1",
    taskNumber: 12,
    status: "concluded",
    variantsCount: 2,
    baseBranch: "main",
    baseCommit: "abcdef1234567890",
    createdAt: "2026-07-03T08:00:00.000Z",
    winnerVariantKey: "b",
    verdictOutcome: "winner",
  },
  {
    id: "exp-2",
    title: "Overlay sweep",
    taskId: "task-2",
    taskNumber: 13,
    status: "running",
    variantsCount: 3,
    baseBranch: "release",
    baseCommit: "123456abcdef7890",
    createdAt: "2026-07-03T09:00:00.000Z",
    winnerVariantKey: null,
    verdictOutcome: null,
  },
];

const tasks: Array<Pick<TaskDTO, "id" | "number" | "title" | "taskKey">> = [
  { id: "task-1", number: 12, taskKey: "KEY", title: "Implement feature" },
  { id: "task-2", number: 13, taskKey: "KEY", title: "Polish docs" },
];

const variants: ExperimentVariant[] = [
  { key: "a", label: "Control", config: {} },
  { key: "b", label: "Candidate", config: { runnerId: "claude" } },
];

const rubric: ExperimentRubric = {
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
      guidance: "Maps to the spec",
      scale: { min: 1, max: 5 },
      weight: 1,
      optional: true,
    },
  ],
};

function renderList(overrides: {
  items?: ExperimentListItemDTO[];
  error?: string | null;
  labels?: ExperimentListLabels;
} = {}): string {
  return renderToStaticMarkup(
    createElement(ExperimentList, {
      slug: "proj",
      items: overrides.items ?? experiments,
      labels: overrides.labels ?? listLabels,
      error: overrides.error ?? null,
      createSlot: createElement("button", null, "New experiment"),
    }),
  );
}

describe("ExperimentList", () => {
  it("renders rows with task links, status, short pin, and verdict summary", () => {
    const html = renderList();

    expect(html).toContain("Two runner comparison");
    expect(html).toContain("/projects/proj/tasks/12");
    expect(html).toContain("KEY-12");
    expect(html).toContain("Concluded");
    expect(html).toContain("abcdef1");
    expect(html).toContain("Winner: b");
    expect(html).toContain("/projects/proj/experiments/exp-1");
  });

  it("renders the empty and error states without fake rows", () => {
    const empty = renderList({ items: [] });
    const error = renderList({ items: [], error: "DB unavailable" });

    expect(empty).toContain("No experiments yet");
    expect(empty).not.toContain('data-testid="experiment-row"');
    expect(error).toContain("Experiment list failed");
    expect(error).toContain("DB unavailable");
  });

  it("renders localized labels supplied by the page", () => {
    const ru = renderList({
      labels: {
        ...listLabels,
        title: "Эксперименты",
        columns: { ...listLabels.columns, variants: "Варианты" },
        status: { ...listLabels.status, running: "В работе" },
      },
    });

    expect(ru).toContain("Эксперименты");
    expect(ru).toContain("Варианты");
    expect(ru).toContain("В работе");
  });

  it("does not render the default create action when the page suppresses it", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentList, {
        slug: "proj",
        items: experiments,
        labels: listLabels,
        createSlot: null,
      }),
    );

    expect(html).not.toContain("New experiment");
  });
});

describe("CreateExperimentForm", () => {
  it("renders task creation, pinned-base, variant overlay, and default rubric inputs", () => {
    const html = renderToStaticMarkup(
      createElement(CreateExperimentForm, {
        labels: createLabels,
        tasks,
        defaultBaseBranch: "main",
        defaultVariants: variants,
        defaultRubric: rubric,
        busy: false,
        error: null,
      }),
    );

    expect(html).toContain("Create task inline");
    expect(html).toContain("Explicit ref");
    expect(html).toContain("Rules add");
    expect(html).toContain("MCPs remove");
    expect(html).toContain("Subagents add");
    expect(html).toContain("Correctness");
    expect(html).toContain("Spec traceability");
    expect(html).toContain("optional");
  });
});
