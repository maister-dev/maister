import type {
  AutoPromotionReaders,
  AutoPromotionRunView,
  EvaluateAutoPromotionInput,
} from "@/lib/auto-promotion/evaluate";
import type { DiffChangeStatEntry } from "@/lib/worktree";

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUILT_IN_LANES } from "@/lib/auto-promotion/config";
import {
  evaluateAutoPromotion,
  INELIGIBLE_REASONS,
  NOT_APPLICABLE_REASONS,
} from "@/lib/auto-promotion/evaluate";

const NOW = new Date("2026-07-03T12:00:00Z");
const GRACE_ELAPSED = new Date(NOW.getTime() - 20 * 60_000);

function docFile(): DiffChangeStatEntry {
  return {
    path: "README.md",
    status: "M",
    additions: 1,
    deletions: 0,
    binary: false,
  };
}

function okReaders(): AutoPromotionReaders {
  return {
    hasOpenHitl: async () => false,
    readinessGreen: async () => true,
    externalCheck: async () => "passed",
    readDepsFiles: async () => [],
  };
}

function baseInput(
  patch: {
    run?: Partial<AutoPromotionRunView>;
    project?: { id: string; autoPromotion?: unknown };
    files?: DiffChangeStatEntry[];
    readers?: Partial<AutoPromotionReaders>;
    now?: Date;
  } = {},
): EvaluateAutoPromotionInput {
  return {
    run: {
      id: "r1",
      projectId: "p1",
      status: "Review",
      runKind: "flow",
      taskId: "t1",
      parentRunId: null,
      workspaceMode: null,
      deliveryPolicySnapshot: null,
      executionPolicy: null,
      promotionHold: null,
      reviewEnteredAt: GRACE_ELAPSED,
      ...patch.run,
    },
    project: patch.project ?? {
      id: "p1",
      autoPromotion: { enabled: true, lanes: BUILT_IN_LANES },
    },
    files: patch.files ?? [docFile()],
    now: patch.now ?? NOW,
    readers: { ...okReaders(), ...patch.readers },
  };
}

describe("evaluateAutoPromotion — happy path", () => {
  const original = process.env.MAISTER_AUTO_PROMOTION;

  beforeEach(() => delete process.env.MAISTER_AUTO_PROMOTION);
  afterEach(() => {
    if (original === undefined) delete process.env.MAISTER_AUTO_PROMOTION;
    else process.env.MAISTER_AUTO_PROMOTION = original;
  });

  it("otherwise-eligible docs run ⇒ eligible with anchor + eligibleAt", async () => {
    const v = await evaluateAutoPromotion(baseInput());

    expect(v).toEqual({
      verdict: "eligible",
      lane: "docs",
      mode: undefined,
      reviewEnteredAt: GRACE_ELAPSED.toISOString(),
      eligibleAt: new Date(GRACE_ELAPSED.getTime() + 10 * 60_000).toISOString(),
    });
  });
});

describe("evaluateAutoPromotion — one owning assertion per term", () => {
  const original = process.env.MAISTER_AUTO_PROMOTION;

  beforeEach(() => delete process.env.MAISTER_AUTO_PROMOTION);
  afterEach(() => {
    if (original === undefined) delete process.env.MAISTER_AUTO_PROMOTION;
    else process.env.MAISTER_AUTO_PROMOTION = original;
  });

  it("term 1 — env off ⇒ disabled(platform)", async () => {
    process.env.MAISTER_AUTO_PROMOTION = "off";
    expect(await evaluateAutoPromotion(baseInput())).toEqual({
      verdict: "disabled",
      scope: "platform",
    });
  });

  it("term 2 — project master off (NULL config) ⇒ disabled(project)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ project: { id: "p1", autoPromotion: null } }),
    );

    expect(v).toEqual({ verdict: "disabled", scope: "project" });
  });

  it("term 2 — malformed config ⇒ ineligible(config_invalid)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ project: { id: "p1", autoPromotion: { enabled: "x" } } }),
    );

    expect(v).toMatchObject({
      verdict: "ineligible",
      reason: "config_invalid",
    });
  });

  it("term 3 — status ≠ Review ⇒ not_applicable(status)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ run: { status: "Done" } }),
    );

    expect(v).toEqual({ verdict: "not_applicable", reason: "status" });
  });

  it("term 4 — run_kind ≠ flow ⇒ not_applicable(run_kind)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ run: { runKind: "scratch" } }),
    );

    expect(v).toEqual({ verdict: "not_applicable", reason: "run_kind" });
  });

  it("term 5 — no task ⇒ not_applicable(no_task)", async () => {
    const v = await evaluateAutoPromotion(baseInput({ run: { taskId: null } }));

    expect(v).toEqual({ verdict: "not_applicable", reason: "no_task" });
  });

  it("term 6 — orchestrator child ⇒ not_applicable(orchestrator_child)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ run: { parentRunId: "parent" } }),
    );

    expect(v).toEqual({
      verdict: "not_applicable",
      reason: "orchestrator_child",
    });
  });

  it("term 7 — shared workspace ⇒ not_applicable(shared_workspace)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ run: { workspaceMode: "shared" } }),
    );

    expect(v).toEqual({
      verdict: "not_applicable",
      reason: "shared_workspace",
    });
  });

  it("term 8 — delivery trigger auto_on_ready ⇒ not_applicable(auto_on_ready)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({
        run: { deliveryPolicySnapshot: { trigger: "auto_on_ready" } },
      }),
    );

    expect(v).toEqual({ verdict: "not_applicable", reason: "auto_on_ready" });
  });

  it("term 8 — execution-policy promotion auto_on_ready ⇒ not_applicable(auto_on_ready)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({
        run: {
          executionPolicy: {
            preset: "supervised",
            overrides: { promotion: "auto_on_ready" },
          },
        },
      }),
    );

    expect(v).toEqual({ verdict: "not_applicable", reason: "auto_on_ready" });
  });

  it("term 9 — hold ⇒ held", async () => {
    const hold = { source: "user" as const, createdAt: NOW.toISOString() };
    const v = await evaluateAutoPromotion(
      baseInput({ run: { promotionHold: hold } }),
    );

    expect(v).toEqual({ verdict: "held", hold });
  });

  it("term 10 — deny-list file ⇒ ineligible(deny_list)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ files: [{ ...docFile(), path: "CLAUDE.md" }] }),
    );

    expect(v).toMatchObject({ verdict: "ineligible", reason: "deny_list" });
  });

  it("term 11 — no single lane ⇒ ineligible(no_lane)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ files: [docFile(), { ...docFile(), path: "src/x.ts" }] }),
    );

    expect(v).toMatchObject({ verdict: "ineligible", reason: "no_lane" });
  });

  it("term 11 — overlapping lanes ⇒ ineligible(ambiguous_lane)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ files: [{ ...docFile(), path: "x/__tests__/n.md" }] }),
    );

    expect(v).toMatchObject({
      verdict: "ineligible",
      reason: "ambiguous_lane",
    });
  });

  it("term 11 — empty diff ⇒ ineligible(empty_diff)", async () => {
    const v = await evaluateAutoPromotion(baseInput({ files: [] }));

    expect(v).toMatchObject({ verdict: "ineligible", reason: "empty_diff" });
  });

  it("term 11 — deps content fails ⇒ ineligible(deps_content)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({
        files: [{ ...docFile(), path: "package.json" }],
        readers: {
          readDepsFiles: async () => [
            { path: "package.json", status: "A", base: null, branch: "{}" },
          ],
        },
      }),
    );

    expect(v).toMatchObject({ verdict: "ineligible", reason: "deps_content" });
  });

  it("term 12 — checks advisory ⇒ ineligible(checks_not_strict)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({
        run: {
          executionPolicy: {
            preset: "supervised",
            overrides: { checks: "advisory" },
          },
        },
      }),
    );

    expect(v).toMatchObject({
      verdict: "ineligible",
      reason: "checks_not_strict",
    });
  });

  it("term 13 — open HITL ⇒ ineligible(pending_hitl)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ readers: { hasOpenHitl: async () => true } }),
    );

    expect(v).toMatchObject({ verdict: "ineligible", reason: "pending_hitl" });
  });

  it("term 14 — readiness not green ⇒ ineligible(readiness_not_green)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ readers: { readinessGreen: async () => false } }),
    );

    expect(v).toMatchObject({
      verdict: "ineligible",
      reason: "readiness_not_green",
    });
  });

  const withCheckLane = {
    id: "p1",
    autoPromotion: {
      enabled: true,
      lanes: [
        {
          class: "docs",
          enabled: true,
          delayMinutes: 10,
          requireExternalCheckId: "ci",
        },
      ],
    },
  };

  it("term 15 — external check not declared ⇒ ineligible(external_check_missing)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({
        project: withCheckLane,
        readers: { externalCheck: async () => "not_declared" },
      }),
    );

    expect(v).toMatchObject({
      verdict: "ineligible",
      reason: "external_check_missing",
    });
  });

  it("term 15 — external check declared but not passed ⇒ ineligible(external_check_not_passed)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({
        project: withCheckLane,
        readers: { externalCheck: async () => "declared_not_passed" },
      }),
    );

    expect(v).toMatchObject({
      verdict: "ineligible",
      reason: "external_check_not_passed",
    });
  });

  it("term 16 — no review anchor ⇒ ineligible(no_review_anchor)", async () => {
    const v = await evaluateAutoPromotion(
      baseInput({ run: { reviewEnteredAt: null } }),
    );

    expect(v).toMatchObject({
      verdict: "ineligible",
      reason: "no_review_anchor",
    });
  });

  it("term 16 — grace not elapsed ⇒ ineligible(grace_pending) carrying eligibleAt", async () => {
    const recent = new Date(NOW.getTime() - 2 * 60_000);
    const v = await evaluateAutoPromotion(
      baseInput({ run: { reviewEnteredAt: recent } }),
    );

    expect(v).toMatchObject({ verdict: "ineligible", reason: "grace_pending" });
    expect(v.verdict === "ineligible" && v.eligibleAt).toBe(
      new Date(recent.getTime() + 10 * 60_000).toISOString(),
    );
  });
});

describe("verdict reason-code i18n closure (EN+RU)", () => {
  const en = JSON.parse(readFileSync("messages/en.json", "utf8"));
  const ru = JSON.parse(readFileSync("messages/ru.json", "utf8"));

  it("every IneligibleReason has a label in both locales", () => {
    for (const reason of INELIGIBLE_REASONS) {
      expect(en.autoPromotion?.reason?.[reason], `en ${reason}`).toBeTruthy();
      expect(ru.autoPromotion?.reason?.[reason], `ru ${reason}`).toBeTruthy();
    }
  });

  it("every NotApplicableReason has a label in both locales", () => {
    for (const reason of NOT_APPLICABLE_REASONS) {
      expect(
        en.autoPromotion?.notApplicable?.[reason],
        `en ${reason}`,
      ).toBeTruthy();
      expect(
        ru.autoPromotion?.notApplicable?.[reason],
        `ru ${reason}`,
      ).toBeTruthy();
    }
  });
});
