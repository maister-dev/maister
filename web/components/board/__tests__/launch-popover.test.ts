import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CONTRACT under test — `components/board/launch-popover.tsx` (M18 T1.5).
// The board Launch control is modal-first: the primary button opens a dialog
// that loads `/api/runs/launch-options` and then POSTs `/api/runs` with the
// selected flow, runner, branches, and delivery policy. The dialog is NOT in
// the DOM until opened, so the default render never fetches launch options.
//
// `LaunchPopover` is a "use client" component using `useTranslations`,
// `useRouter`, and React hooks, so this render harness mocks `next-intl` +
// `next/navigation` at the module boundary (the repo's component tests are
// otherwise pure-render; these two hooks are the only context this needs).
// renderToStaticMarkup — no jsdom (repo convention).
// ---------------------------------------------------------------------------

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  BudgetScopeFields,
  LaunchPopover,
  budgetTextHasInvalid,
  buildLaunchBody,
  effectiveLaunchVerdict,
  isBudgetFieldInvalid,
  launchUnavailableReasonMessage,
  pruneBudgetText,
} from "@/components/board/launch-popover";

function render(over: Partial<Record<string, string>> = {}): string {
  return renderToStaticMarkup(
    createElement(LaunchPopover, {
      taskId: "task-1",
      label: "launch",
      disabledLabel: "unavailable",
      ...over,
    }),
  );
}

describe("LaunchPopover — modal-first launch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the launch dialog trigger with the threaded label", () => {
    const html = render();

    expect(html).toContain("launch");
    expect(html).not.toContain('role="dialog"');
  });

  it("does not render launch option controls until it is opened", () => {
    const html = render();

    // The dialog and its branch-select labels are absent on the initial render.
    expect(html).not.toContain("run.baseBranch");
    expect(html).not.toContain("run.targetBranch");
    expect(html).not.toContain("<select");
  });

  it("renders the disabled label and disables the trigger when a reason is set", () => {
    const html = render({ disabledReason: "supervisor offline" });

    expect(html).toContain("unavailable");
    expect(html.match(/disabled=""/g)?.length).toBe(1);
  });
});

describe("LaunchPopover — launchability reason copy", () => {
  const translate = (key: string): string => `copy:${key}`;

  it("maps no_revision to a user-facing message key", () => {
    expect(launchUnavailableReasonMessage("no_revision", translate)).toBe(
      "copy:launchUnavailableReason.noRevision",
    );
  });

  it("maps not_enabled to a user-facing message key", () => {
    expect(launchUnavailableReasonMessage("not_enabled", translate)).toBe(
      "copy:launchUnavailableReason.notEnabled",
    );
  });

  it("keeps unknown backend reasons visible for diagnostics", () => {
    expect(launchUnavailableReasonMessage("new_reason", translate)).toBe(
      "new_reason",
    );
  });
});

// ---------------------------------------------------------------------------
// Cost-budget governance — launch budget inputs (T5.1).
//
// The numeric budget inputs are pure: validated positive-int-only (empty =
// unlimited) and pruned into a sparse BudgetAxis that folds into the execution
// policy. The unattended-unbounded hint shows iff preset=unattended AND the
// pruned axis is null (no field set) — that derived condition is exactly
// `preset === "unattended" && pruneBudgetText(text) === null`.
// ---------------------------------------------------------------------------

const BUDGET_FIELD_LABELS = {
  maxTokens: "Max tokens",
  hardMaxTokens: "Hard max tokens",
  warnAtPct: "Warn %",
  consecutiveFailures: "Consecutive failures",
  wallClockMinutes: "Wall-clock minutes",
};

// ---------------------------------------------------------------------------
// ADR-119 — force-relaunch gate selection + POST body flag.
// effectiveLaunchVerdict picks the `relaunch` verdict in force mode and the
// `launchability` verdict otherwise; buildLaunchBody stamps allowConcurrent =
// forceRelaunch. (No jsdom in this project, so the interactive dialog flow is
// covered by these pure helpers + the route integration tests.)
// ---------------------------------------------------------------------------

describe("LaunchPopover — effectiveLaunchVerdict (force vs manual gate)", () => {
  const options = {
    launchability: { launchable: false, reason: "busy", blockers: [] },
    relaunch: { launchable: true, reason: "launchable" },
  };

  it("force mode reads the relaunch verdict (launchable while the manual gate is busy)", () => {
    expect(effectiveLaunchVerdict(options, true)).toEqual({
      launchable: true,
      reason: "launchable",
    });
  });

  it("manual mode reads the launchability verdict", () => {
    expect(effectiveLaunchVerdict(options, false)).toEqual({
      launchable: false,
      reason: "busy",
      blockers: [],
    });
  });

  it("force mode surfaces a blocked relaunch verdict (task gate not bypassed)", () => {
    expect(
      effectiveLaunchVerdict(
        {
          launchability: { launchable: false, reason: "busy", blockers: [] },
          relaunch: { launchable: false, reason: "blocked" },
        },
        true,
      ),
    ).toEqual({ launchable: false, reason: "blocked" });
  });

  it("force mode falls back to launchability when relaunch is absent (back-compat)", () => {
    expect(
      effectiveLaunchVerdict(
        {
          launchability: {
            launchable: true,
            reason: "launchable",
            blockers: [],
          },
        },
        true,
      ),
    ).toEqual({ launchable: true, reason: "launchable", blockers: [] });
  });
});

describe("LaunchPopover — buildLaunchBody allowConcurrent flag", () => {
  const base = {
    taskId: "task-1",
    flowId: "flow-1",
    runnerId: "runner-1",
    baseBranch: "main",
    targetBranch: "main",
    deliveryPolicy: {
      strategy: "merge" as const,
      push: "never" as const,
      trigger: "manual" as const,
      targetBranch: "main",
    },
    executionPolicy: { preset: "supervised" as const },
    packageVersions: undefined,
  };

  it("stamps allowConcurrent:true in force-relaunch mode", () => {
    expect(buildLaunchBody({ ...base, forceRelaunch: true })).toMatchObject({
      taskId: "task-1",
      flowId: "flow-1",
      allowConcurrent: true,
    });
  });

  it("stamps allowConcurrent:false in manual mode", () => {
    expect(buildLaunchBody({ ...base, forceRelaunch: false })).toMatchObject({
      allowConcurrent: false,
    });
  });
});

describe("LaunchPopover budget — field validation (AC-UI-2)", () => {
  it("accepts a positive integer", () => {
    expect(isBudgetFieldInvalid("maxTokens", "1000")).toBe(false);
  });

  it("allows an empty value (unlimited)", () => {
    expect(isBudgetFieldInvalid("maxTokens", "")).toBe(false);
    expect(isBudgetFieldInvalid("maxTokens", "   ")).toBe(false);
  });

  it("rejects a negative, zero, or non-numeric value", () => {
    expect(isBudgetFieldInvalid("maxTokens", "-5")).toBe(true);
    expect(isBudgetFieldInvalid("maxTokens", "0")).toBe(true);
    expect(isBudgetFieldInvalid("maxTokens", "1.5")).toBe(true);
    expect(isBudgetFieldInvalid("maxTokens", "abc")).toBe(true);
  });

  it("caps warnAtPct at 100", () => {
    expect(isBudgetFieldInvalid("warnAtPct", "80")).toBe(false);
    expect(isBudgetFieldInvalid("warnAtPct", "100")).toBe(false);
    expect(isBudgetFieldInvalid("warnAtPct", "101")).toBe(true);
  });

  it("flags an axis as invalid when any field is invalid", () => {
    expect(budgetTextHasInvalid({ run: { maxTokens: "1000" } })).toBe(false);
    expect(budgetTextHasInvalid({ run: { maxTokens: "-1" } })).toBe(true);
    expect(budgetTextHasInvalid({ tree: { wallClockMinutes: "x" } })).toBe(
      true,
    );
    expect(budgetTextHasInvalid({})).toBe(false);
  });
});

describe("LaunchPopover budget — prune to sparse axis (fold)", () => {
  it("returns null when every field is empty (unlimited)", () => {
    expect(pruneBudgetText({})).toBeNull();
    expect(pruneBudgetText({ run: { maxTokens: "" } })).toBeNull();
  });

  it("keeps only positive-int fields and non-empty scopes", () => {
    expect(
      pruneBudgetText({
        run: { maxTokens: "1000", hardMaxTokens: "", warnAtPct: "0" },
        task: {},
        tree: { wallClockMinutes: "30" },
      }),
    ).toEqual({
      run: { maxTokens: 1000 },
      tree: { wallClockMinutes: 30 },
    });
  });

  it("drops a scope whose every field is empty/invalid", () => {
    expect(
      pruneBudgetText({ task: { maxTokens: "abc", consecutiveFailures: "0" } }),
    ).toBeNull();
  });
});

describe("LaunchPopover budget — unattended-unbounded hint gate (AC-UI-3)", () => {
  // The component renders the hint iff preset === "unattended" AND the pruned
  // axis is null; these assert the load-bearing predicate.
  it("is unbounded (hint shows) only when no budget field is set", () => {
    expect(pruneBudgetText({}) === null).toBe(true);
  });

  it("is bounded (hint hidden) once any positive field is set", () => {
    expect(pruneBudgetText({ run: { maxTokens: "500" } }) === null).toBe(false);
  });
});

describe("BudgetScopeFields — input group render", () => {
  function renderScope(scope: "run" | "task" | "tree"): string {
    return renderToStaticMarkup(
      createElement(BudgetScopeFields, {
        scope,
        heading: scope.toUpperCase(),
        values: {},
        fieldLabels: BUDGET_FIELD_LABELS,
        fieldPlaceholders: { hardMaxTokens: "default ×1.25", warnAtPct: "80" },
        invalidLabel: "Positive integer only",
        onChange: vi.fn(),
      }),
    );
  }

  it("renders the four token/failure inputs for the run scope", () => {
    const html = renderScope("run");

    expect(html).toContain('data-testid="budget-run-maxTokens"');
    expect(html).toContain('data-testid="budget-run-hardMaxTokens"');
    expect(html).toContain('data-testid="budget-run-warnAtPct"');
    expect(html).toContain('data-testid="budget-run-consecutiveFailures"');
    // Run scope has NO wall-clock field (tree only).
    expect(html).not.toContain('data-testid="budget-run-wallClockMinutes"');
  });

  it("adds the wall-clock input only for the tree scope", () => {
    const html = renderScope("tree");

    expect(html).toContain('data-testid="budget-tree-wallClockMinutes"');
  });

  it("hints the ×1.25 default on the hard-max placeholder", () => {
    const html = renderScope("run");

    expect(html).toContain("default ×1.25");
  });

  it("marks an invalid field with an aria error", () => {
    const html = renderToStaticMarkup(
      createElement(BudgetScopeFields, {
        scope: "run",
        heading: "RUN",
        values: { maxTokens: "-1" },
        fieldLabels: BUDGET_FIELD_LABELS,
        fieldPlaceholders: {},
        invalidLabel: "Positive integer only",
        onChange: vi.fn(),
      }),
    );

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Positive integer only");
  });
});
