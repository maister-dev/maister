import type { TaskRelationView } from "@/lib/social/relations";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { RelationsEditor } from "@/components/social/relations-editor";

const labels = {
  title: "Relations",
  empty: "No relations yet.",
  add: "Add",
  adding: "Adding…",
  numberPlaceholder: "task #",
  searchPlaceholder: "Search tasks",
  searchNoResults: "No tasks found.",
  remove: "Remove relation to",
  kindOut: {
    blocks: "blocks",
    depends_on: "depends on",
    parent_of: "parent of",
  },
  kindIn: {
    blocks: "blocked by",
    depends_on: "required by",
    parent_of: "child of",
  },
  errorConfig: "bad",
  errorNotFound: "missing",
  errorForbidden: "forbidden",
  errorGeneric: "failed",
};

const relations: TaskRelationView[] = [
  {
    id: "r1",
    direction: "out",
    kind: "blocks",
    other: {
      taskId: "t2",
      key: "MAI",
      number: 2,
      title: "Other",
      status: "Backlog",
    },
  },
  {
    id: "r2",
    direction: "in",
    kind: "depends_on",
    other: {
      taskId: "t3",
      key: "MAI",
      number: 3,
      title: "Third",
      status: "InFlight",
    },
  },
];

const relationCandidates = [
  {
    taskId: "t2",
    key: "MAI",
    number: 2,
    title: "Other",
    prompt: "Fix another part",
    status: "Backlog",
  },
];

describe("RelationsEditor", () => {
  it("renders direction-aware labels with counterpart KEY-N links", () => {
    const html = renderToStaticMarkup(
      createElement(RelationsEditor, {
        slug: "maister",
        taskNumber: 1,
        relations,
        relationCandidates,
        canEdit: true,
        labels,
      }),
    );

    // Outgoing `blocks` keeps the canonical label; incoming `depends_on`
    // renders its inverse ("required by") — inverse labels are render-time.
    expect(html).toContain("blocks");
    expect(html).toContain("required by");
    expect(html).toContain('href="/projects/maister/tasks/2"');
    expect(html).toContain("MAI-2");
    expect(html).toContain("MAI-3");
    // Edit affordances present for members.
    expect(html).toContain("Search tasks");
  });

  it("hides edit affordances for viewers", () => {
    const html = renderToStaticMarkup(
      createElement(RelationsEditor, {
        slug: "maister",
        taskNumber: 1,
        relations,
        relationCandidates,
        canEdit: false,
        labels,
      }),
    );

    expect(html).not.toContain("Search tasks");
    expect(html).not.toContain(">Add<");
  });

  it("renders the empty state", () => {
    const html = renderToStaticMarkup(
      createElement(RelationsEditor, {
        slug: "maister",
        taskNumber: 1,
        relations: [],
        relationCandidates,
        canEdit: true,
        labels,
      }),
    );

    expect(html).toContain("No relations yet.");
  });
});
