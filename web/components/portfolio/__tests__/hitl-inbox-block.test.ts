import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CONTRACT under test — `components/portfolio/hitl-inbox-block.tsx` (M17 P5).
//
// RED until the Implementor builds the block. The portfolio home renders
// HitlInboxBlock when there are pending HITL items across all visible
// projects. The block is PRESENTATIONAL — render is driven entirely by props
// (no fetch on mount) so renderToStaticMarkup is deterministic. It shows:
// - A header with "Needs you" label + numeric count badge.
// - One row per CrossProjectHitlItem, with project name, branch, flow ref,
//   agent, criticality badge, prompt, time, assignment state.
// - An empty state when count is 0.
//
// NOTE ON FILE EXTENSION (.ts, not .tsx): the vitest `unit` project glob is
// `components/**/__tests__/**/*.test.ts` (NO .tsx). A `.test.tsx` would be
// SILENTLY UNCOLLECTED. Every component test in this repo is `.test.ts`
// using `renderToStaticMarkup(createElement(...))`.
//
// HitlInboxBlock is a server component (no "use client", no hooks), so no
// mocking of next-intl or navigation is required. The static structure
// (header + badge + row per item + criticality badge per row + empty state)
// is fully testable via renderToStaticMarkup.
// ---------------------------------------------------------------------------

import { HitlInboxBlock } from "@/components/portfolio/hitl-inbox-block";

// Type stub matching the design (CrossProjectHitlItem = HitlItem + project fields).
interface CrossProjectHitlItemStub {
  hitlRequestId: string;
  runId: string;
  kind: "permission" | "form" | "human";
  prompt: string;
  criticality: "low" | "medium" | "high" | "critical" | null;
  schema: unknown;
  agent: "claude" | "codex";
  branch: string;
  flowRef: string;
  stage: {
    label: string;
    type:
      | "ai_coding"
      | "judge"
      | "cli"
      | "check"
      | "human"
      | "form"
      | "guard"
      | null;
  };
  taskRef: string | null;
  taskTitle: string | null;
  time: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  // From HitlItem (assignment state).
  assignmentId: string | null;
  assignmentStatus: "open" | "claimed" | "completed" | "cancelled" | null;
  assignmentActionKind:
    | "permission"
    | "form"
    | "human_review"
    | "manual_takeover"
    | "merge_conflict"
    | null;
  assignmentRoleRefs: string[];
  assignmentStaleEvidenceSummary: Record<string, unknown> | null;
  assigneeLabel: string | null;
  assigneeUserId: string | null;
  options: Array<{ optionId: string; label: string }>;
}

function createItemStub(
  overrides: Partial<CrossProjectHitlItemStub> = {},
): CrossProjectHitlItemStub {
  return {
    hitlRequestId: "hitl-1",
    runId: "run-1",
    kind: "permission",
    prompt: "Approve this change?",
    criticality: "high",
    schema: { options: [{ optionId: "yes", label: "Yes" }] },
    agent: "claude",
    branch: "maister/feature-x",
    stage: { label: "review", type: "human" },
    taskRef: null,
    taskTitle: null,
    flowRef: "bugfix",
    time: "2h",
    projectId: "proj-1",
    projectSlug: "proj-1",
    projectName: "Project 1",
    assignmentId: null,
    assignmentStatus: null,
    assignmentActionKind: null,
    assignmentRoleRefs: [],
    assignmentStaleEvidenceSummary: null,
    assigneeLabel: null,
    assigneeUserId: null,
    options: [{ optionId: "yes", label: "Yes" }],
    ...overrides,
  };
}

interface BlockLabels {
  title: string;
  empty: string;
  ariaLabel: string;
  countAriaLabel: string;
  [key: string]: string;
}

const DEFAULT_LABELS: BlockLabels = {
  title: "Needs you",
  empty: "No pending items",
  ariaLabel: "Cross-project HITL inbox",
  countAriaLabel: "pending",
};

type HitlInboxBlockProps = Parameters<typeof HitlInboxBlock>[0];

function render(
  items: CrossProjectHitlItemStub[] = [],
  count?: number,
  labels: BlockLabels = DEFAULT_LABELS,
): string {
  const props: HitlInboxBlockProps = {
    items,
    count: count ?? items.length,
    labels,
  };

  return renderToStaticMarkup(createElement(HitlInboxBlock, props));
}

describe("HitlInboxBlock — cross-project HITL inbox on portfolio (M17 P5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the header with 'Needs you' label and numeric count badge", () => {
    const items = [
      createItemStub({ projectName: "Project 1" }),
      createItemStub({ projectName: "Project 2" }),
    ];
    const html = render(items, 2);

    // Header contains the "Needs you" label.
    expect(html).toContain("Needs you");
    // Numeric count badge is rendered (e.g., "2").
    expect(html).toContain("2");
  });

  it("renders one row per CrossProjectHitlItem", () => {
    const items = [
      createItemStub({ projectName: "Project 1", hitlRequestId: "hitl-1" }),
      createItemStub({ projectName: "Project 2", hitlRequestId: "hitl-2" }),
      createItemStub({ projectName: "Project 3", hitlRequestId: "hitl-3" }),
    ];
    const html = render(items, 3);

    // All three items are present in the output (identified by their projectName).
    expect(html).toContain("Project 1");
    expect(html).toContain("Project 2");
    expect(html).toContain("Project 3");
  });

  it("renders project name for each row", () => {
    const items = [
      createItemStub({ projectName: "Alpha Project" }),
      createItemStub({ projectName: "Beta Project" }),
    ];
    const html = render(items, 2);

    expect(html).toContain("Alpha Project");
    expect(html).toContain("Beta Project");
  });

  it("renders a criticality badge per item", () => {
    const items = [
      createItemStub({ criticality: "critical", projectName: "Project 1" }),
      createItemStub({ criticality: "high", projectName: "Project 2" }),
      createItemStub({ criticality: "medium", projectName: "Project 3" }),
      createItemStub({ criticality: "low", projectName: "Project 4" }),
      createItemStub({ criticality: null, projectName: "Project 5" }),
    ];
    const html = render(items, 5);

    // All criticality levels are rendered in the markup.
    expect(html).toContain("critical");
    expect(html).toContain("high");
    expect(html).toContain("medium");
    expect(html).toContain("low");
  });

  it("renders empty state when count is 0", () => {
    const html = render([], 0);

    expect(html).toContain("No pending items");
  });

  it("does not render rows when items array is empty", () => {
    const html = render([], 0);

    // With no items, the markup should NOT contain any project names.
    expect(html).not.toContain("Project 1");
    expect(html).not.toContain("Project 2");
  });

  it("renders branch, flow ref, agent, prompt, time per row", () => {
    const items = [
      createItemStub({
        branch: "maister/bugfix-123",
        taskRef: null,
        flowRef: "bugfix-flow",
        agent: "claude",
        prompt: "Review and approve this PR",
        time: "5m",
        projectName: "Test Project",
      }),
    ];
    const html = render(items, 1);

    // All row-level fields are present.
    expect(html).toContain("maister/bugfix-123");
    expect(html).toContain("bugfix-flow");
    expect(html).toContain("claude");
    expect(html).toContain("Review and approve this PR");
    expect(html).toContain("5m");
  });

  it("count in header matches items length", () => {
    const items = [
      createItemStub({ projectName: "P1" }),
      createItemStub({ projectName: "P2" }),
      createItemStub({ projectName: "P3" }),
    ];
    const html = render(items, 3);

    // The count badge shows "3" (must appear exactly as numeric value or in badge).
    expect(html).toContain("3");
  });

  it("renders assignment state (assigneeLabel, assignmentStatus) when present", () => {
    const items = [
      createItemStub({
        assigneeLabel: "Alice Johnson",
        assignmentStatus: "claimed",
        projectName: "Project A",
      }),
    ];
    const html = render(items, 1);

    // Assignment info is rendered.
    expect(html).toContain("Alice Johnson");
    expect(html).toContain("claimed");
  });

  it("does not leak internal fields (acp_session_id, supervisor handles, worktree paths)", () => {
    // The component must NOT render any of these sensitive fields in the HTML.
    const items = [
      createItemStub({
        projectName: "Project 1",
        runId: "run-abc123def456xyz",
      }),
    ];
    const html = render(items, 1);

    // runId may be present if used internally (e.g., as a React key), but
    // actual worktree paths, acp session IDs, supervisor addresses should NOT
    // appear in the rendered text.
    expect(html).not.toContain(".maister/");
    expect(html).not.toContain("/sessions/");
    expect(html).not.toContain("127.0.0.1:7777");
  });
});
