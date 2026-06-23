import type { BacklogCard } from "@/lib/queries/board";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  TaskCardEditModal,
  TaskInlineEditableField,
} from "@/components/board/task-card-editing";

const card: BacklogCard = {
  taskId: "task-1",
  number: 7,
  keyRef: "MAI-7",
  title: "Inline editable title",
  prompt: "Inline editable description",
  flowRef: "aif",
  priority: "high",
  runCount: 0,
  blockedBy: [],
  flowId: "flow-1",
  triageStatus: null,
  runnerId: null,
  targetBranch: null,
  promotionMode: null,
  executionPolicy: null,
  relations: [],
  childTasks: [],
};

describe("Task card editing", () => {
  it("renders an inline edit affordance for card title fields", () => {
    const html = renderToStaticMarkup(
      createElement(TaskInlineEditableField, {
        slug: "maister",
        taskNumber: 7,
        field: "title",
        value: "Inline editable title",
        canEdit: true,
        href: "/projects/maister/tasks/7",
      }),
    );

    expect(html).toContain("Inline editable title");
    expect(html).toContain('href="/projects/maister/tasks/7"');
    expect(html).toContain('aria-label="board.editTitle"');
  });

  it("renders custom inline view content when supplied", () => {
    const html = renderToStaticMarkup(
      createElement(TaskInlineEditableField, {
        slug: "maister",
        taskNumber: 7,
        field: "prompt",
        value: "Inline editable description",
        canEdit: true,
        renderView: (value: string) =>
          createElement("strong", { "data-testid": "custom-view" }, value),
      }),
    );

    expect(html).toContain('data-testid="custom-view"');
    expect(html).toContain("Inline editable description");
  });

  it("renders multiline task prompts as markdown by default", () => {
    const html = renderToStaticMarkup(
      createElement(TaskInlineEditableField, {
        slug: "maister",
        taskNumber: 7,
        field: "prompt",
        value: "**Bold** description\n\n- Item",
        canEdit: true,
        multiline: true,
      }),
    );

    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<li>Item</li>");
    expect(html).not.toContain("**Bold**");
  });

  it("renders fenced code blocks with preview chrome", () => {
    const html = renderToStaticMarkup(
      createElement(TaskInlineEditableField, {
        slug: "maister",
        taskNumber: 7,
        field: "prompt",
        value: "```ts\nconst answer = 42;\n```",
        canEdit: true,
        multiline: true,
      }),
    );

    expect(html).toContain("data-markdown-code-block");
    expect(html).toContain("ts");
    expect(html).toContain("const answer = 42;");
  });

  it("renders the full-card edit trigger without mounting the dialog", () => {
    const html = renderToStaticMarkup(
      createElement(TaskCardEditModal, {
        card,
        slug: "maister",
        canEdit: true,
        triggerClassName: "visible-edit-trigger",
      }),
    );

    expect(html).toContain('data-testid="task-card-edit-trigger"');
    expect(html).toContain('aria-label="board.editTask"');
    expect(html).toContain("visible-edit-trigger");
    expect(html).not.toContain('role="dialog"');
  });
});
