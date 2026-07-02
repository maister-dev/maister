// ADR-072 Task 13 — RunHitlResponse review-gate wiring: the client container
// maps the run.* catalog keys for the new gate-panel labels and forwards the
// server-computed thread counts (optional prop) plus the loop fields that ride
// on the stored review schema into HitlDecisionControls.
//
// House pattern: renderToStaticMarkup (no jsdom), next-intl mocked as a
// namespace.key echo so the wiring is asserted through literal key paths.
// State/effects do not run under static render — the POST path is not the
// target here (covered by e2e), only the render wiring.

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

import { RunHitlResponse } from "@/components/board/run-hitl-response";

type ResponseProps = Parameters<typeof RunHitlResponse>[0];

const REVIEW_SCHEMA = {
  review: true,
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

const CONSENSUS_SCHEMA = {
  kind: "consensus_resolution",
  round: 1,
  allowedDecisions: [
    "pick-draft-1",
    "provide-resolution",
    "re-run-round",
    "abort",
  ],
  drafts: [{ participantLabel: "Planner A", excerpt: "Bounded draft." }],
  disagreements: [{ axis: "risk", summary: "Different rollout order." }],
};

const BUDGET_BREACH_SCHEMA = {
  kind: "budget_breach",
  scope: "run",
  meter: "tokens",
  current: 1200,
  limit: 1000,
};

function render(over: Partial<ResponseProps> = {}): string {
  const base: ResponseProps = {
    runId: "run-1",
    hitlRequestId: "hitl-1",
    kind: "human",
    options: [],
    schema: REVIEW_SCHEMA,
    canAct: true,
  };

  return renderToStaticMarkup(
    createElement(RunHitlResponse, { ...base, ...over }),
  );
}

// The opening tag of the <button> whose text content contains `label`.
function buttonTagFor(html: string, label: string): string {
  const idx = html.indexOf(label);

  expect(idx).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", idx);

  expect(start).toBeGreaterThan(-1);

  return html.slice(start, html.indexOf(">", start) + 1);
}

describe("RunHitlResponse — review gate panel wiring (ADR-072 Task 13)", () => {
  it("renders the loop chip from the schema's server-stamped loop fields", () => {
    const html = render({
      schema: { ...REVIEW_SCHEMA, maxLoops: 3, gateAttempt: 2 },
    });

    expect(html).toContain("run.reviewLoopChip");
  });

  it("renders no chip for a legacy schema without loop fields", () => {
    const html = render();

    expect(html).not.toContain("run.reviewLoopChip");
  });

  it("disables rework at the exhaustion boundary with the translated reason", () => {
    const html = render({
      schema: { ...REVIEW_SCHEMA, maxLoops: 1, gateAttempt: 2 },
    });

    expect(buttonTagFor(html, "run.decisionRework")).toContain("disabled");
    expect(buttonTagFor(html, "run.sendBackWithComments")).toContain(
      "disabled",
    );
    expect(buttonTagFor(html, "run.decisionApprove")).not.toContain("disabled");
    expect(html).toContain("run.reviewReworkExhausted");
  });

  it("keeps rework enabled below the boundary", () => {
    const html = render({
      schema: { ...REVIEW_SCHEMA, maxLoops: 2, gateAttempt: 2 },
    });

    expect(buttonTagFor(html, "run.decisionRework")).not.toContain("disabled");
    expect(html).not.toContain("run.reviewReworkExhausted");
  });

  it("renders count badges and the approve soft-warn from reviewCounts", () => {
    const html = render({
      reviewCounts: { openCount: 2, outdatedCount: 1 },
    });

    expect(html).toContain("run.reviewOpenCount");
    expect(html).toContain("run.reviewOutdatedCount");
    expect(html).toContain("run.reviewApproveOpenWarn");
    expect(buttonTagFor(html, "run.decisionApprove")).not.toContain("disabled");
  });

  it("renders no badges and no warn without reviewCounts (board/inbox consumers)", () => {
    const html = render();

    expect(html).not.toContain("run.reviewOpenCount");
    expect(html).not.toContain("run.reviewOutdatedCount");
    expect(html).not.toContain("run.reviewApproveOpenWarn");
  });

  it("renders no badges and no warn when counts are zero", () => {
    const html = render({
      reviewCounts: { openCount: 0, outdatedCount: 0 },
    });

    expect(html).not.toContain("run.reviewOpenCount");
    expect(html).not.toContain("run.reviewOutdatedCount");
    expect(html).not.toContain("run.reviewApproveOpenWarn");
  });
});

describe("RunHitlResponse — budget breach staged controls", () => {
  it("disables budget actions while a composite claim is active", () => {
    const html = render({
      kind: "budget_breach",
      schema: BUDGET_BREACH_SCHEMA,
      claimStage: "preserving",
      availableOptions: [
        {
          optionId: "raise",
          label: "raise",
          helperText: "raise",
          destructive: false,
          dropAllowed: false,
          requiresBranchName: false,
          modes: [],
        },
        {
          optionId: "abandon",
          label: "abandon",
          helperText: "abandon",
          destructive: true,
          dropAllowed: false,
          requiresBranchName: false,
          modes: [],
        },
      ],
    });

    expect(buttonTagFor(html, "run.budgetRaiseResume")).toContain("disabled");
    expect(buttonTagFor(html, "run.budgetAbandon")).toContain("disabled");
    expect(html).toContain('data-testid="budget-claim-stage"');
  });
});

describe("RunHitlResponse — consensus resolution wiring (M41)", () => {
  it("routes a consensus human HITL to the purpose-built decision controls", () => {
    const html = render({ schema: CONSENSUS_SCHEMA });

    expect(html).toContain('data-testid="consensus-hitl-card"');
    expect(html).toContain("run.consensusTitle");
    expect(html).toContain("run.consensusRound");
    expect(html).toContain("run.consensusPickDraft");
    expect(html).toContain("run.consensusProvideResolution");
    expect(html).not.toContain("run.schemaLabel");
    expect(html).not.toContain("run.confidenceLabel");
  });
});
