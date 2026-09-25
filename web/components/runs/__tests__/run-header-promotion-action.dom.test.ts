// @vitest-environment jsdom

// ADR-181 (C): the header's one-click Promote names why a squashing PR
// promotion was refused when the PR branch holds commits the run lacks — not
// the generic CONFLICT copy, which reads as a merge conflict.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const feedbackError = vi.fn();

vi.mock("@/components/feedback/feedback-provider", () => ({
  useFeedback: () => ({ success: vi.fn(), error: feedbackError }),
}));

import { RunHeaderPromotionAction } from "@/components/runs/run-header-promotion-action";

const roots: Root[] = [];

function render(): void {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);
  act(() => {
    root.render(
      createElement(RunHeaderPromotionAction, {
        operation: {
          runId: "run-1",
          targetBranch: "main",
          deliveryPolicy: {
            strategy: "pull_request",
            push: "on_success",
            trigger: "manual",
            targetBranch: "main",
          },
          mode: "pull_request",
          reviewedTargetCommit: "target-tip",
          canPromote: true,
          reviewReady: true,
          diffTruncated: false,
          legacyNeedsRelaunch: false,
        },
        reviewHref: "#review",
        labels: {
          promote: "run.promote",
          started: "run.promotionStarted",
          targetDrift: "run.targetDrift",
        },
      }),
    );
  });
}

async function promoteRefusedWith(body: Record<string, unknown>) {
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
  render();

  const button = document.body.querySelector(
    '[data-testid="run-header-promote"]',
  );

  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
  feedbackError.mockReset();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("RunHeaderPromotionAction — a refused Promote", () => {
  it("names the PR branch's own commits as the reason", async () => {
    await promoteRefusedWith({
      code: "CONFLICT",
      message: "server text",
      details: { reason: "publication_diverged" },
    });

    expect(feedbackError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "run.publicationDiverged" }),
    );
  });

  it("keeps the code's copy for any other CONFLICT", async () => {
    await promoteRefusedWith({ code: "CONFLICT", message: "merge conflict" });

    expect(feedbackError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "run.error.CONFLICT" }),
    );
  });
});
