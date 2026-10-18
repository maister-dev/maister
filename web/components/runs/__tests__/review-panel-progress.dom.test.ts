// @vitest-environment jsdom

import type {
  ReviewPanelLabels,
  ReviewPanelProps,
} from "@/components/runs/review-panel";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/workbench/diff-view", () => ({
  DiffView: () => createElement("div", { "data-testid": "diff-view" }),
}));

import { ReviewPanel } from "@/components/runs/review-panel";

const LABELS = {
  promoteTo: "Promote to",
  promotionMode: "Promotion mode",
  readinessReady: "Ready",
  readinessBlocked: "Blocked",
  prLink: "Pull request",
  targetDrift: "Target drift",
  promoteAnyway: "Promote anyway",
  diffTruncated: "Diff truncated",
  promoteTruncated: "Promote truncated",
  promotionMerge: "Merge",
  promotionRebaseMerge: "Rebase + merge",
  promotionPullRequest: "Pull request",
  promotionAiRebaseMerge: "AI rebase + merge",
  behindAhead: "1 behind · 1 ahead",
  syncBranch: "Sync branch",
  syncInProgress: "Sync in progress",
  promotionInProgress: "Promoting…",
  promotionInProgressHint: "Checking branches and merging.",
  operationTakingLonger: "This is taking longer than usual.",
  resolveWithAgent: "Resolve with agent",
  autoFinalize: "Auto-finalize",
  autoFinalizeHint: "Finalize after resolve.",
} satisfies ReviewPanelLabels;

const BASE_PROPS: ReviewPanelProps = {
  runId: "run-1",
  baseBranch: "main",
  baseCommit: "abc1234def5678",
  runBranch: "maister/feature-x",
  targetBranch: "main",
  promotionMode: "merge",
  deliveryPolicy: {
    strategy: "merge",
    push: "never",
    trigger: "manual",
    targetBranch: "main",
  },
  reviewedTargetCommit: "abc1234def5678",
  readiness: {
    readiness: "ready",
    externalGates: [],
    requiredArtifacts: [],
    reasons: [],
  },
  diff: { files: [], perFile: [], truncated: false },
  labels: LABELS,
  sync: { inProgress: null },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  router.refresh.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ReviewPanel promotion feedback", () => {
  it("shows immediate and long-running feedback while promotion is pending", async () => {
    let finish!: (response: Response) => void;

    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );

    act(() => {
      root.render(createElement(ReviewPanel, BASE_PROPS));
    });

    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="review-promote"]',
    );

    if (!button) throw new Error("missing promotion button");

    await act(async () => button.click());

    expect(
      host
        .querySelector("[data-testid=review-panel]")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(
      host.querySelector("[data-testid=review-promotion-in-progress]")
        ?.textContent,
    ).toContain(LABELS.promotionInProgress);
    expect(button.disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(
      host.querySelector("[data-testid=review-promotion-in-progress]")
        ?.textContent,
    ).toContain(LABELS.operationTakingLonger);

    await act(async () => finish(Response.json({ ok: true })));
    expect(router.refresh).toHaveBeenCalledOnce();
  });
});
