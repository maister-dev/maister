// HitlCard collapsed-tier render wiring. House pattern: renderToStaticMarkup
// (no jsdom), next-intl mocked as a namespace.key echo, next/navigation mocked.
// The expand → lazy inbox-context fetch → gates/diff/progress tier needs
// interaction and is covered by e2e (web/e2e/inbox.spec.ts), not static render.

import type { HitlItem } from "@/lib/queries/hitl";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { HitlCard } from "@/components/inbox/hitl-card";

const BASE: HitlItem = {
  hitlRequestId: "h1",
  runId: "run-1",
  kind: "permission",
  assignmentId: null,
  assignmentStatus: null,
  assignmentActionKind: null,
  assignmentRoleRefs: [],
  assignmentStaleEvidenceSummary: null,
  assigneeLabel: null,
  assigneeUserId: null,
  agent: "claude",
  branch: "maister/feature-x",
  flowRef: "bugfix",
  stage: { label: "review", type: "human" },
  taskRef: "ACME-12",
  taskTitle: "Refactor session store",
  prompt: "Allow npm install express-rate-limit?",
  options: [
    { optionId: "allow", label: "Allow" },
    { optionId: "deny", label: "Deny" },
  ],
  time: "2h",
  createdAt: "2026-07-02T10:00:00.000Z",
  schema: null,
  criticality: "critical",
};

const REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

function render(over: Partial<HitlItem> = {}): string {
  return renderToStaticMarkup(
    createElement(HitlCard, {
      item: { ...BASE, ...over },
      canAct: true,
      currentUserId: "u1",
    }),
  );
}

describe("HitlCard — collapsed tier", () => {
  it("renders the task title, KEY-N, and a localized criticality pill", () => {
    const html = render();

    expect(html).toContain("Refactor session store");
    expect(html).toContain("ACME-12");
    expect(html).toContain("run.criticality.critical");
  });

  it("renders the stage chip label (node id)", () => {
    expect(render()).toContain("review");
  });

  it("renders the stage chip label even when the type is unresolved", () => {
    expect(render({ stage: { label: "step-7", type: null } })).toContain(
      "step-7",
    );
  });

  it("renders the branch (workspace) chip", () => {
    expect(render()).toContain("maister/feature-x");
  });

  it("permission asks are answerable from collapsed (Allow/Deny inline)", () => {
    const html = render();

    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
    expect(html).not.toContain("inbox.respond");
  });

  it("form/human asks show a Respond affordance, not inline options", () => {
    expect(
      render({ kind: "human", options: [], schema: REVIEW_SCHEMA }),
    ).toContain("inbox.respond");
    expect(render({ kind: "form", options: [], schema: null })).toContain(
      "inbox.respond",
    );
  });

  it("links to the run", () => {
    const html = render();

    expect(html).toContain('href="/runs/run-1"');
    expect(html).toContain("inbox.viewRun");
  });

  it("falls back to the prompt as the headline when there is no task title", () => {
    const html = render({ taskTitle: null, taskRef: null });

    expect(html).toContain("Allow npm install express-rate-limit?");
  });
});
