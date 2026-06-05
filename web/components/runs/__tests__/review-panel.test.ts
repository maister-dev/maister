import type { ReadinessDTO } from "@/lib/queries/readiness";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CONTRACT under test — `components/runs/review-panel.tsx` (M18 T4.2).
//
// RED until the Implementor builds the panel. The page renders ReviewPanel when
// `detail.status === "Review" && detail.runKind === "flow"`. The panel is
// PRESENTATIONAL — render is driven entirely by props (no fetch on mount) so
// renderToStaticMarkup is deterministic. It shows the base→run→target spine
// (named branches + base commit), the readiness summary (from a ReadinessDTO
// prop), the raw diff in a <pre>, a promotion-mode selector
// (local_merge|pull_request), and a "Promote to <targetBranch>" action that
// POSTs /api/runs/{runId}/promote with {mode, targetBranch, reviewedTargetCommit,
// allowTargetDrift?}. On a PRECONDITION "target advanced" response it shows a
// drift warning + an explicit "Promote anyway" (allowTargetDrift:true). On
// CONFLICT it surfaces a conflict/assignment card. When `legacyNeedsRelaunch` it
// renders a PRECONDITION "relaunch to promote" state INSTEAD of the Promote
// action (and never renders a null/undefined branch).
//
// NOTE ON FILE EXTENSION (.ts, not .tsx — flagged in the QA report): the vitest
// `unit` project glob is `components/**/__tests__/**/*.test.ts` (NO .tsx). A
// `review-panel.test.tsx` would be SILENTLY UNCOLLECTED. Every component test in
// this repo is `.test.ts` using `renderToStaticMarkup(createElement(...))` (see
// `components/board/__tests__/launch-popover.test.ts`). We follow that
// convention so collection is guaranteed.
//
// ReviewPanel is a "use client" component using `useTranslations` + `useRouter`,
// so this harness mocks `next-intl` + `next/navigation` at the module boundary
// (the launch-popover pattern). The next-intl mock echoes `namespace.key`, so
// the i18n keys the panel must use are asserted literally in the markup.
// ---------------------------------------------------------------------------

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { ReviewPanel } from "@/components/runs/review-panel";

const READY: ReadinessDTO = {
  readiness: "ready",
  externalGates: [],
  requiredArtifacts: [],
  reasons: [],
};

const BLOCKED: ReadinessDTO = {
  readiness: "blocked",
  externalGates: [
    { gateId: "ci", status: "pending", description: "CI must pass" },
  ],
  requiredArtifacts: [
    { defId: "impl-diff", kind: "diff", present: false, validity: null },
  ],
  reasons: ['required artifact "impl-diff" has no current row'],
};

const LABELS = {
  promoteTo: "run.promoteTo",
  promotionMode: "run.promotionMode",
  readinessReady: "run.readinessReady",
  readinessBlocked: "run.readinessBlocked",
  prLink: "run.prLink",
  targetDrift: "run.targetDrift",
  promoteAnyway: "run.promoteAnyway",
};

type ReviewPanelProps = Parameters<typeof ReviewPanel>[0];

function render(over: Partial<ReviewPanelProps> = {}): string {
  const base: ReviewPanelProps = {
    runId: "run-1",
    baseBranch: "main",
    baseCommit: "abc1234def5678",
    runBranch: "maister/feature-x",
    targetBranch: "release",
    promotionMode: "local_merge",
    reviewedTargetCommit: "deadbeefcafe0123",
    readiness: READY,
    diff: "diff --git a/file.txt b/file.txt\n+run change\n",
    labels: LABELS,
  } as ReviewPanelProps;

  return renderToStaticMarkup(createElement(ReviewPanel, { ...base, ...over }));
}

describe("ReviewPanel — base→run→target review surface (M18 T4.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the base→run→target spine (all three branch names + base commit)", () => {
    const html = render();

    expect(html).toContain("main"); // base branch
    expect(html).toContain("maister/feature-x"); // run branch
    expect(html).toContain("release"); // target branch
    // The base commit (or a stable prefix of it) is shown so the reviewer knows
    // which base the diff was computed against.
    expect(html).toContain("abc1234");
  });

  it("renders the readiness summary from the ReadinessDTO prop", () => {
    const html = render({ readiness: BLOCKED });

    // The blocked readiness verdict surfaces (i18n key for the blocked state).
    expect(html).toContain("run.readinessBlocked");
    // A blocking reason from the DTO is shown to the reviewer.
    expect(html).toContain("impl-diff");
  });

  it("renders the raw diff text inside a <pre>", () => {
    const html = render();

    expect(html).toContain("<pre");
    expect(html).toContain("+run change");
    // The diff lives inside the <pre>, not elsewhere.
    const pre = html.slice(html.indexOf("<pre"));

    expect(pre).toContain("+run change");
  });

  it("names the exact target in the Promote button label", () => {
    const html = render({ targetBranch: "release" });

    // The promote action label NAMES the exact target branch. The next-intl mock
    // returns the key, so the label is composed with the target value appearing
    // in the rendered markup alongside the promote key.
    expect(html).toContain("run.promoteTo");
    expect(html).toContain("release");
  });

  it("carries reviewedTargetCommit in the promote form/control markup", () => {
    const html = render({ reviewedTargetCommit: "deadbeefcafe0123" });

    // The live target HEAD the panel rendered against MUST be present in the
    // submitted payload — as a hidden input value or a data attribute — so the
    // promote claim tx can run the optimistic-concurrency drift check.
    expect(html).toContain("deadbeefcafe0123");
  });

  it("renders a promotion-mode selector offering local_merge and pull_request", () => {
    const html = render();

    expect(html).toContain("run.promotionMode");
    expect(html).toContain("local_merge");
    expect(html).toContain("pull_request");
  });

  it("shows the drift warning + a 'Promote anyway' control in the drift state", () => {
    const html = render({ driftDetected: true } as Partial<ReviewPanelProps>);

    // The target advanced since review → the panel warns and offers an explicit
    // override (which posts allowTargetDrift:true). Both must be present.
    expect(html).toContain("run.targetDrift");
    expect(html).toContain("run.promoteAnyway");
  });

  it("surfaces a conflict/assignment card in the conflict state", () => {
    const html = render({
      conflict: {
        parentRepoPath: "/repos/myapp",
        targetBranch: "release",
        runBranch: "maister/feature-x",
        command: "git merge --no-ff maister/feature-x",
      },
    } as Partial<ReviewPanelProps>);

    // The conflict handoff names the parent repo path, target, run branch, and
    // the exact failing command — the manual-resolution affordance.
    expect(html).toContain("/repos/myapp");
    expect(html).toContain("git merge --no-ff maister/feature-x");
  });

  it("legacyNeedsRelaunch renders the relaunch state and NOT the promote action; never a null branch", () => {
    const html = render({
      legacyNeedsRelaunch: true,
      // A pre-M18 row may have null branch metadata; the panel must not render it.
      targetBranch: null as unknown as string,
      baseBranch: null as unknown as string,
    } as Partial<ReviewPanelProps>);

    // The "relaunch to promote" PRECONDITION state is shown instead of Promote.
    expect(html).toContain("run.relaunchToPromote");
    expect(html).not.toContain("run.promoteTo");
    // No null/undefined branch ever leaks into the markup.
    expect(html).not.toContain("null");
    expect(html).not.toContain("undefined");
  });
});
