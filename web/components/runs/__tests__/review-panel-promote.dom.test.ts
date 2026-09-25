// @vitest-environment jsdom

// ADR-181 (C): what the review panel shows when Promote is refused. A squashing
// PR promotion whose forced update would drop commits only the PR branch has is
// a CONFLICT too, but no merge conflict: the panel says what happened and links
// the git panel's Update — never the "resolve manually: git merge" card.

import type { ReactNode } from "react";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/runs/run-1",
}));

// jsdom has no layout: the design-system primitives render as plain elements,
// the panel's own state and requests stay real.
vi.mock("@heroui/react", async () => {
  const React = await import("react");
  const Pass = ({ children }: { children?: ReactNode }) => children;

  return {
    Button: ({
      children,
      isDisabled,
      onClick,
      className,
      type,
      ...rest
    }: {
      children?: ReactNode;
      isDisabled?: boolean;
      onClick?: () => void;
      className?: string;
      type?: "button";
      "data-testid"?: string;
    }) =>
      React.createElement(
        "button",
        {
          className,
          "data-testid": rest["data-testid"],
          disabled: isDisabled,
          type,
          onClick,
        },
        children,
      ),
    Input: (props: { "data-testid"?: string; value?: string }) =>
      React.createElement("input", {
        "data-testid": props["data-testid"],
        readOnly: true,
        type: "hidden",
        value: props.value,
      }),
    Select: Object.assign(Pass, {
      Trigger: Pass,
      Value: () => null,
      Indicator: () => null,
      Popover: Pass,
    }),
    ListBox: Object.assign(Pass, { Item: Pass }),
  };
});

vi.mock("@/components/workbench/diff-view", () => ({ DiffView: () => null }));

import { ReviewPanel } from "@/components/runs/review-panel";

type ReviewPanelProps = Parameters<typeof ReviewPanel>[0];

const UPDATE_HREF = "/runs/run-1?git=update";

const roots: Root[] = [];

function render(): void {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);

  const props = {
    runId: "run-1",
    baseBranch: "main",
    baseCommit: "abc1234def5678",
    runBranch: "maister/feature-x",
    targetBranch: "main",
    promotionMode: "pull_request",
    deliveryPolicy: {
      strategy: "pull_request",
      push: "on_success",
      trigger: "manual",
      targetBranch: "main",
    },
    reviewedTargetCommit: "deadbeefcafe0123",
    readiness: {
      readiness: "ready",
      externalGates: [],
      requiredArtifacts: [],
      reasons: [],
    },
    diff: { files: [], perFile: [], truncated: false },
    labels: {
      promoteTo: "run.promoteTo",
      promotionMode: "run.promotionMode",
      readinessReady: "run.readinessReady",
      readinessBlocked: "run.readinessBlocked",
      prLink: "run.prLink",
      targetDrift: "run.targetDrift",
      promoteAnyway: "run.promoteAnyway",
      diffTruncated: "run.diffTruncated",
      promoteTruncated: "run.promoteTruncated",
      promotionMerge: "run.promotionMerge",
      promotionRebaseMerge: "run.promotionRebaseMerge",
      promotionPullRequest: "run.promotionPullRequest",
      promotionAiRebaseMerge: "run.promotionAiRebaseMerge",
      behindAhead: "run.behindAhead",
      syncBranch: "run.syncBranch",
      syncInProgress: "run.syncInProgress",
      resolveWithAgent: "run.resolveWithAgent",
      autoFinalize: "run.autoFinalize",
      autoFinalizeHint: "run.autoFinalizeHint",
    },
    sync: { inProgress: null },
    updateHref: UPDATE_HREF,
  } as unknown as ReviewPanelProps;

  act(() => {
    root.render(createElement(ReviewPanel, props));
  });
}

function refuseWith(body: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function promote(): Promise<void> {
  const button = byTestId("review-promote");

  if (!button) throw new Error("missing the Promote button");

  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ReviewPanel — a refused Promote", () => {
  it("says the PR branch keeps commits the run lacks and links Update, not the merge-conflict card", async () => {
    refuseWith({
      code: "CONFLICT",
      message: "server text",
      details: { reason: "publication_diverged" },
    });
    render();

    await promote();

    const notice = byTestId("review-publication-diverged");

    expect(notice?.textContent).toContain("run.publicationDiverged");
    expect(
      byTestId("review-publication-diverged-update")?.getAttribute("href"),
    ).toBe(UPDATE_HREF);
    expect(byTestId("review-conflict")).toBeNull();
    expect(document.body.textContent).not.toContain("server text");
  });

  it("still shows the merge-conflict card for any other CONFLICT", async () => {
    refuseWith({ code: "CONFLICT", message: "merge conflict" });
    render();

    await promote();

    expect(byTestId("review-conflict")).not.toBeNull();
    expect(byTestId("review-publication-diverged")).toBeNull();
  });
});
