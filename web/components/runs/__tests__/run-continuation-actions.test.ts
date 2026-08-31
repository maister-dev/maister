import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  RunContinuationActions,
  type RunContinuationActionsProps,
} from "@/components/runs/run-continuation-actions";

// ADR-159 UI: availability is SERVER-OWNED — the component renders what it is
// given and never re-derives eligibility. These assert the five states an
// operator can land in.

const base: RunContinuationActionsProps = {
  runId: "run-1",
  reworkClaimAvailable: true,
  disabledReason: null,
  reentryNodeId: "checks",
  claimOwnerUserId: null,
  viewerUserId: "user-owner",
  worktreePath: "/repos/app/.maister/app/runs/r1/worktree",
  branch: "maister/task-42-attempt-1",
  canAct: true,
};

function render(over: Partial<RunContinuationActionsProps> = {}): string {
  return renderToStaticMarkup(
    createElement(RunContinuationActions, { ...base, ...over }),
  );
}

describe("RunContinuationActions", () => {
  it("offers Take for rework when the server says it is available", () => {
    const html = render();

    expect(html).toContain("runContinuation.takeForRework");
    expect(html).not.toContain("disabled=");
    // The resolved re-entry node is surfaced so the operator knows where the
    // run will come back in.
    expect(html).toContain("runContinuation.reentryAt");
  });

  it("disables the claim and shows the server-supplied reason", () => {
    const html = render({
      reworkClaimAvailable: false,
      disabledReason: "an orchestrator child run cannot be taken for rework",
      reentryNodeId: null,
    });

    expect(html).toContain("disabled=");
    expect(html).toContain("orchestrator child run cannot be taken");
  });

  it("shows Return and Release to the claim owner", () => {
    const html = render({
      claimOwnerUserId: "user-owner",
      viewerUserId: "user-owner",
      reworkClaimAvailable: false,
    });

    expect(html).toContain("runContinuation.returnToFlow");
    expect(html).toContain("runContinuation.release");
    expect(html).toContain("checkoutContext.title");
    expect(html).not.toContain("runContinuation.notOwner");
  });

  // The display path and the clipboard path are DIFFERENT values. Rendering the
  // real absolute path leaks the host layout; copying the abbreviated one hands
  // the operator a string that cannot be `cd`-ed into. Both halves have to hold
  // at once — passing one value for both is the regression this fences.
  it("renders the abbreviated worktree path but keeps the real one for copy", () => {
    const html = render({
      claimOwnerUserId: "user-owner",
      viewerUserId: "user-owner",
      reworkClaimAvailable: false,
      worktreePath: "/Users/developer/.maister/worktrees/app/run-1",
      displayWorktreePath: "<maister_worktrees>/app/run-1",
    });

    expect(html).toContain("&lt;maister_worktrees&gt;/app/run-1");
    expect(html).not.toContain("/Users/developer/.maister/worktrees/app/run-1");
  });

  // Without a display form the real path is what the field shows — the takeover
  // surface relies on the same defaulting.
  it("falls back to the real path when no display form is given", () => {
    const html = render({
      claimOwnerUserId: "user-owner",
      viewerUserId: "user-owner",
      reworkClaimAvailable: false,
    });

    expect(html).toContain("/repos/app/.maister/app/runs/r1/worktree");
  });

  it("hides Return and Release from a non-owner", () => {
    const html = render({
      claimOwnerUserId: "user-owner",
      viewerUserId: "user-other",
      reworkClaimAvailable: false,
    });

    expect(html).toContain("runContinuation.notOwner");
    expect(html).not.toContain("runContinuation.returnToFlow");
    expect(html).not.toContain("runContinuation.release");
  });

  it("disables the owner's actions when the viewer cannot act", () => {
    const html = render({
      claimOwnerUserId: "user-owner",
      viewerUserId: "user-owner",
      reworkClaimAvailable: false,
      canAct: false,
    });

    expect(html).toContain("runContinuation.returnToFlow");
    expect(html).toContain("disabled=");
  });
});
