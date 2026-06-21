import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors-core";
import {
  assertNoBlindShip,
  blindShipLockedOptions,
  budgetFromSnapshot,
  checksFromSnapshot,
  crashRetryFromSnapshot,
  permissionsFromSnapshot,
  humanGateFromSnapshot,
  onStuckFromSnapshot,
  promotionFromSnapshot,
  commitsFromSnapshot,
  dirtyResolveFromSnapshot,
  resolveAutoRetryPolicy,
  resolveHumanGateDisposition,
  defaultExecutionPolicy,
  executionPolicySchema,
  expandExecutionPolicy,
  isBlindShip,
  requiresLaunchUnattended,
  resolveExecutionPolicy,
  reworkExhaustionFromSnapshot,
  type ExecutionPolicy,
} from "@/lib/runs/execution-policy";
import { applyDefaultBudgetForUnattended } from "@/lib/runs/budget-default";

describe("expandExecutionPolicy — preset → axes", () => {
  it("supervised expands to the all-stop baseline", () => {
    expect(expandExecutionPolicy({ preset: "supervised" })).toEqual({
      preset: "supervised",
      reworkExhaustion: "escalate",
      crashRetry: "fail",
      checks: "strict",
      permissions: "ask",
      humanGate: "stop",
      onStuck: "escalate",
      promotion: "manual",
      commits: "keep_all",
      dirtyResolve: "ask",
      budget: {},
    });
  });

  it("assisted relaxes permissions + dirty only, keeps human + promote manual", () => {
    expect(expandExecutionPolicy({ preset: "assisted" })).toMatchObject({
      permissions: "auto_approve",
      dirtyResolve: "proceed",
      humanGate: "stop",
      promotion: "manual",
      checks: "strict",
    });
  });

  it("unattended hands off to the end but keeps checks strict + onStuck escalate", () => {
    expect(expandExecutionPolicy({ preset: "unattended" })).toEqual({
      preset: "unattended",
      reworkExhaustion: "escalate",
      crashRetry: "ralph_loop",
      checks: "strict",
      permissions: "auto_approve",
      humanGate: "auto_pass",
      onStuck: "escalate",
      promotion: "auto_on_ready",
      commits: "squash_rework",
      dirtyResolve: "proceed",
      budget: {},
    });
  });

  it("per-axis overrides win over the preset base", () => {
    const resolved = expandExecutionPolicy({
      preset: "supervised",
      overrides: { permissions: "auto_approve", commits: "defer" },
    });

    expect(resolved.permissions).toBe("auto_approve");
    expect(resolved.commits).toBe("defer");
    // untouched axes keep the supervised base
    expect(resolved.humanGate).toBe("stop");
    expect(resolved.checks).toBe("strict");
  });

  it("every preset defaults budget → all-unset (unlimited)", () => {
    for (const preset of ["supervised", "assisted", "unattended"] as const) {
      expect(expandExecutionPolicy({ preset }).budget).toEqual({});
    }
  });

  it("folds a budget override over the all-unset base", () => {
    const resolved = expandExecutionPolicy({
      preset: "supervised",
      overrides: { budget: { run: { maxTokens: 100 } } },
    });

    expect(resolved.budget).toEqual({ run: { maxTokens: 100 } });
    expect(resolved.budget.run?.maxTokens).toBe(100);
  });
});

describe("resolveExecutionPolicy — precedence", () => {
  const launch: ExecutionPolicy = { preset: "unattended" };
  const task: ExecutionPolicy = { preset: "assisted" };
  const project: ExecutionPolicy = {
    preset: "supervised",
    overrides: { permissions: "auto_approve" },
  };

  it("launch override wins over task and project", () => {
    expect(
      resolveExecutionPolicy({
        launchOverride: launch,
        taskDefault: task,
        projectDefault: project,
      }),
    ).toEqual(launch);
  });

  it("task default wins over project when no launch override", () => {
    expect(
      resolveExecutionPolicy({ taskDefault: task, projectDefault: project }),
    ).toEqual(task);
  });

  it("project default applies when no launch/task", () => {
    expect(resolveExecutionPolicy({ projectDefault: project })).toEqual(
      project,
    );
  });

  it("falls back to supervised when nothing is set", () => {
    expect(resolveExecutionPolicy({})).toEqual(defaultExecutionPolicy());
    expect(resolveExecutionPolicy({})).toEqual({ preset: "supervised" });
  });

  it("treats null tiers as absent", () => {
    expect(
      resolveExecutionPolicy({
        launchOverride: null,
        taskDefault: null,
        projectDefault: project,
      }),
    ).toEqual(project);
  });
});

describe("no-blind-ship guard", () => {
  it("accepts every preset as-is (checks stay strict)", () => {
    for (const preset of ["supervised", "assisted", "unattended"] as const) {
      expect(isBlindShip({ preset })).toBe(false);
      expect(() => assertNoBlindShip({ preset })).not.toThrow();
    }
  });

  it("rejects relaxed checks + auto-passed human gate", () => {
    const policy: ExecutionPolicy = {
      preset: "unattended",
      overrides: { checks: "advisory" },
    };

    expect(isBlindShip(policy)).toBe(true);
    expect(() => assertNoBlindShip(policy)).toThrowError(/no validation/i);
  });

  it("rejects skipped checks + auto-promotion", () => {
    const policy: ExecutionPolicy = {
      preset: "supervised",
      overrides: { checks: "skip", promotion: "auto_on_ready" },
    };

    expect(isBlindShip(policy)).toBe(true);

    let code: string | undefined;

    try {
      assertNoBlindShip(policy);
    } catch (err) {
      if (isMaisterError(err)) code = err.code;
    }
    expect(code).toBe("PRECONDITION");
  });

  it("allows relaxed checks when a human floor remains (gate stops + manual promote)", () => {
    const policy: ExecutionPolicy = {
      preset: "supervised",
      overrides: { checks: "advisory", humanGate: "stop", promotion: "manual" },
    };

    expect(isBlindShip(policy)).toBe(false);
    expect(() => assertNoBlindShip(policy)).not.toThrow();
  });

  it("allows strict checks with full auto-pass + auto-promote (the unattended default)", () => {
    const policy: ExecutionPolicy = {
      preset: "unattended",
      overrides: { humanGate: "auto_pass", promotion: "auto_on_ready" },
    };

    expect(isBlindShip(policy)).toBe(false);
  });
});

describe("resolveAutoRetryPolicy (A2 crashRetry=auto_retry → synthesized ADR-080 retry)", () => {
  const autoRetry: ExecutionPolicy = {
    preset: "supervised",
    overrides: { crashRetry: "auto_retry" },
  };

  it("synthesizes a transient-only, workspace=keep policy for a retry_safe node under auto_retry", () => {
    const policy = resolveAutoRetryPolicy({
      retrySafe: true,
      executionPolicy: autoRetry,
      maxAttempts: 3,
    });

    expect(policy).not.toBeNull();
    expect(policy?.attempts).toBe(3);
    expect(policy?.workspace).toBe("keep");
    // Transient allow-list only — deterministic codes (PRECONDITION/CONFIG/CRASH)
    // are NEVER auto-retried.
    expect([...(policy?.on_errors ?? [])].sort()).toEqual(
      ["ACP_PROTOCOL", "CHECKPOINT", "EXECUTOR_UNAVAILABLE", "SPAWN"].sort(),
    );
  });

  it("returns null for a non-retry_safe node (opt-in gate)", () => {
    expect(
      resolveAutoRetryPolicy({
        retrySafe: false,
        executionPolicy: autoRetry,
        maxAttempts: 3,
      }),
    ).toBeNull();
  });

  it("returns null when the run is not auto_retry (fail / ralph_loop / null)", () => {
    for (const ep of [
      { preset: "supervised" } as ExecutionPolicy,
      { preset: "unattended" } as ExecutionPolicy, // ralph_loop, not auto_retry
      null,
      { preset: "bogus" },
    ]) {
      expect(
        resolveAutoRetryPolicy({
          retrySafe: true,
          executionPolicy: ep,
          maxAttempts: 3,
        }),
      ).toBeNull();
    }
  });

  it("passes the caller's maxAttempts through as the bound", () => {
    expect(
      resolveAutoRetryPolicy({
        retrySafe: true,
        executionPolicy: autoRetry,
        maxAttempts: 7,
      })?.attempts,
    ).toBe(7);
  });
});

describe("requiresLaunchUnattended", () => {
  it("supervised never requires the privileged action", () => {
    expect(requiresLaunchUnattended({ preset: "supervised" })).toBe(false);
  });

  it("assisted does not require it (perms + dirty only, human floor intact)", () => {
    expect(requiresLaunchUnattended({ preset: "assisted" })).toBe(false);
  });

  it("unattended requires it (auto-pass human gate + auto-promote)", () => {
    expect(requiresLaunchUnattended({ preset: "unattended" })).toBe(true);
  });

  it("requires it for a check relaxation on an otherwise-supervised policy", () => {
    expect(
      requiresLaunchUnattended({
        preset: "supervised",
        overrides: { checks: "advisory" },
      }),
    ).toBe(true);
  });

  it("requires it when on-stuck no longer escalates", () => {
    expect(
      requiresLaunchUnattended({
        preset: "supervised",
        overrides: { onStuck: "notify_only" },
      }),
    ).toBe(true);
  });

  it("requires it when an auto-pass human gate is layered onto assisted", () => {
    expect(
      requiresLaunchUnattended({
        preset: "assisted",
        overrides: { humanGate: "auto_pass" },
      }),
    ).toBe(true);
  });

  it("does NOT require it for reworkExhaustion=ship_with_warning (owner decision; no-blind-ship keeps the human floor)", () => {
    expect(
      requiresLaunchUnattended({
        preset: "supervised",
        overrides: { reworkExhaustion: "ship_with_warning" },
      }),
    ).toBe(false);
  });
});

describe("blindShipLockedOptions (launch-UI guard projection)", () => {
  it("locks nothing for the supervised baseline", () => {
    expect(
      blindShipLockedOptions({
        checks: "strict",
        humanGate: "stop",
        promotion: "manual",
      }),
    ).toEqual({
      relaxedChecksDisabled: false,
      autoPassDisabled: false,
      autoPromoteDisabled: false,
    });
  });

  it("disables relaxed checks once a human gate auto-passes", () => {
    expect(
      blindShipLockedOptions({
        checks: "strict",
        humanGate: "auto_pass",
        promotion: "manual",
      }).relaxedChecksDisabled,
    ).toBe(true);
  });

  it("disables relaxed checks once promotion is automatic", () => {
    expect(
      blindShipLockedOptions({
        checks: "strict",
        humanGate: "stop",
        promotion: "auto_on_ready",
      }).relaxedChecksDisabled,
    ).toBe(true);
  });

  it("disables auto-pass and auto-promote once checks are relaxed", () => {
    for (const checks of ["advisory", "skip"] as const) {
      const locks = blindShipLockedOptions({
        checks,
        humanGate: "stop",
        promotion: "manual",
      });

      expect(locks.autoPassDisabled).toBe(true);
      expect(locks.autoPromoteDisabled).toBe(true);
    }
  });
});

describe("executionPolicySchema (launch-body validation)", () => {
  it("parses a bare preset and a preset+overrides", () => {
    expect(executionPolicySchema.parse({ preset: "supervised" })).toEqual({
      preset: "supervised",
    });
    expect(
      executionPolicySchema.parse({
        preset: "unattended",
        overrides: { checks: "advisory", commits: "squash_on_promote" },
      }),
    ).toMatchObject({ preset: "unattended" });
  });

  it("rejects an unknown preset", () => {
    expect(() => executionPolicySchema.parse({ preset: "yolo" })).toThrow();
  });

  it("rejects an unknown override key (strict)", () => {
    expect(() =>
      executionPolicySchema.parse({
        preset: "supervised",
        overrides: { nope: "x" },
      }),
    ).toThrow();
  });

  it("rejects an out-of-domain axis value", () => {
    expect(() =>
      executionPolicySchema.parse({
        preset: "supervised",
        overrides: { checks: "loose" },
      }),
    ).toThrow();
  });
});

describe("checksFromSnapshot (run snapshot → check-strictness, fail-closed)", () => {
  it("null / undefined snapshot → strict (pre-policy runs unchanged)", () => {
    expect(checksFromSnapshot(null)).toBe("strict");
    expect(checksFromSnapshot(undefined)).toBe("strict");
  });

  it("supervised and unattended presets both resolve checks → strict", () => {
    expect(checksFromSnapshot({ preset: "supervised" })).toBe("strict");
    expect(checksFromSnapshot({ preset: "unattended" })).toBe("strict");
  });

  it("an explicit advisory / skip override resolves through", () => {
    expect(
      checksFromSnapshot({
        preset: "assisted",
        overrides: { checks: "advisory" },
      }),
    ).toBe("advisory");
    expect(
      checksFromSnapshot({
        preset: "supervised",
        overrides: { checks: "skip" },
      }),
    ).toBe("skip");
  });

  it("malformed snapshots fail closed to strict (never silently relax)", () => {
    expect(checksFromSnapshot({ preset: "bogus" })).toBe("strict");
    expect(checksFromSnapshot({})).toBe("strict");
    expect(checksFromSnapshot("advisory")).toBe("strict");
    expect(
      checksFromSnapshot({
        preset: "supervised",
        overrides: { checks: "loose" },
      }),
    ).toBe("strict");
  });
});

describe("reworkExhaustionFromSnapshot (run snapshot → rework action, fail-closed)", () => {
  it("null / undefined snapshot → escalate (safe default)", () => {
    expect(reworkExhaustionFromSnapshot(null)).toBe("escalate");
    expect(reworkExhaustionFromSnapshot(undefined)).toBe("escalate");
  });

  it("every preset defaults rework exhaustion → escalate", () => {
    expect(reworkExhaustionFromSnapshot({ preset: "supervised" })).toBe(
      "escalate",
    );
    expect(reworkExhaustionFromSnapshot({ preset: "assisted" })).toBe(
      "escalate",
    );
    expect(reworkExhaustionFromSnapshot({ preset: "unattended" })).toBe(
      "escalate",
    );
  });

  it("explicit fail / ship_with_warning overrides resolve through", () => {
    expect(
      reworkExhaustionFromSnapshot({
        preset: "supervised",
        overrides: { reworkExhaustion: "fail" },
      }),
    ).toBe("fail");
    expect(
      reworkExhaustionFromSnapshot({
        preset: "unattended",
        overrides: { reworkExhaustion: "ship_with_warning" },
      }),
    ).toBe("ship_with_warning");
  });

  it("malformed snapshots fail closed to escalate (never silently ship or fail)", () => {
    expect(reworkExhaustionFromSnapshot({ preset: "bogus" })).toBe("escalate");
    expect(reworkExhaustionFromSnapshot({})).toBe("escalate");
    expect(reworkExhaustionFromSnapshot("fail")).toBe("escalate");
    expect(
      reworkExhaustionFromSnapshot({
        preset: "supervised",
        overrides: { reworkExhaustion: "abandon" },
      }),
    ).toBe("escalate");
  });
});

describe("crashRetryFromSnapshot (run snapshot → crash-retry, fail-closed)", () => {
  it("null / undefined snapshot → fail (never auto-relaunch on a corrupt policy)", () => {
    expect(crashRetryFromSnapshot(null)).toBe("fail");
    expect(crashRetryFromSnapshot(undefined)).toBe("fail");
  });

  it("only unattended resolves crashRetry → ralph_loop", () => {
    expect(crashRetryFromSnapshot({ preset: "supervised" })).toBe("fail");
    expect(crashRetryFromSnapshot({ preset: "assisted" })).toBe("fail");
    expect(crashRetryFromSnapshot({ preset: "unattended" })).toBe("ralph_loop");
  });

  it("an explicit crashRetry override resolves through", () => {
    expect(
      crashRetryFromSnapshot({
        preset: "supervised",
        overrides: { crashRetry: "ralph_loop" },
      }),
    ).toBe("ralph_loop");
  });

  it("malformed snapshots fail closed to fail (never silently relaunch)", () => {
    expect(crashRetryFromSnapshot({ preset: "bogus" })).toBe("fail");
    expect(crashRetryFromSnapshot({})).toBe("fail");
    expect(crashRetryFromSnapshot("ralph_loop")).toBe("fail");
    expect(
      crashRetryFromSnapshot({
        preset: "unattended",
        overrides: { crashRetry: "loop_forever" },
      }),
    ).toBe("fail");
  });
});

describe("permissionsFromSnapshot (run snapshot → permission autonomy, fail-closed)", () => {
  it("null / undefined snapshot → ask (never auto-approve on a corrupt policy)", () => {
    expect(permissionsFromSnapshot(null)).toBe("ask");
    expect(permissionsFromSnapshot(undefined)).toBe("ask");
  });

  it("supervised asks; assisted and unattended auto-approve", () => {
    expect(permissionsFromSnapshot({ preset: "supervised" })).toBe("ask");
    expect(permissionsFromSnapshot({ preset: "assisted" })).toBe(
      "auto_approve",
    );
    expect(permissionsFromSnapshot({ preset: "unattended" })).toBe(
      "auto_approve",
    );
  });

  it("an explicit permissions override resolves through", () => {
    expect(
      permissionsFromSnapshot({
        preset: "supervised",
        overrides: { permissions: "auto_approve" },
      }),
    ).toBe("auto_approve");
  });

  it("malformed snapshots fail closed to ask", () => {
    expect(permissionsFromSnapshot({ preset: "bogus" })).toBe("ask");
    expect(permissionsFromSnapshot("auto_approve")).toBe("ask");
    expect(
      permissionsFromSnapshot({
        preset: "unattended",
        overrides: { permissions: "yolo" },
      }),
    ).toBe("ask");
  });
});

describe("humanGateFromSnapshot / onStuckFromSnapshot (fail-closed)", () => {
  it("humanGate: only unattended auto-passes; null/malformed → stop", () => {
    expect(humanGateFromSnapshot({ preset: "supervised" })).toBe("stop");
    expect(humanGateFromSnapshot({ preset: "assisted" })).toBe("stop");
    expect(humanGateFromSnapshot({ preset: "unattended" })).toBe("auto_pass");
    expect(humanGateFromSnapshot(null)).toBe("stop");
    expect(humanGateFromSnapshot({ preset: "bogus" })).toBe("stop");
  });

  it("onStuck: every preset escalates; null/malformed → escalate", () => {
    expect(onStuckFromSnapshot({ preset: "supervised" })).toBe("escalate");
    expect(onStuckFromSnapshot({ preset: "unattended" })).toBe("escalate");
    expect(
      onStuckFromSnapshot({
        preset: "unattended",
        overrides: { onStuck: "notify_only" },
      }),
    ).toBe("notify_only");
    expect(onStuckFromSnapshot(null)).toBe("escalate");
    expect(onStuckFromSnapshot("notify_only")).toBe("escalate");
  });
});

describe("resolveHumanGateDisposition (B2/B3 decision matrix)", () => {
  it("humanGate=stop always pauses with an assignment (pre-B2 behavior)", () => {
    expect(
      resolveHumanGateDisposition({
        humanGate: "stop",
        onStuck: "escalate",
        hasSafeDefault: true,
        evidenceReady: true,
      }),
    ).toEqual({ action: "pause", assign: true });
  });

  it("auto_pass + machine review ready + safe default → auto_pass", () => {
    expect(
      resolveHumanGateDisposition({
        humanGate: "auto_pass",
        onStuck: "escalate",
        hasSafeDefault: true,
        evidenceReady: true,
      }),
    ).toEqual({ action: "auto_pass" });
  });

  it("auto_pass but review NOT ready → routes per onStuck (escalate = pause+assign)", () => {
    expect(
      resolveHumanGateDisposition({
        humanGate: "auto_pass",
        onStuck: "escalate",
        hasSafeDefault: true,
        evidenceReady: false,
      }),
    ).toEqual({ action: "pause", assign: true });
  });

  it("auto_pass + no safe default → never auto-passes; escalate-pauses by default", () => {
    expect(
      resolveHumanGateDisposition({
        humanGate: "auto_pass",
        onStuck: "escalate",
        hasSafeDefault: false,
        evidenceReady: true,
      }),
    ).toEqual({ action: "pause", assign: true });
  });

  it("onStuck=ship_with_warning ships forward only when a safe default exists", () => {
    expect(
      resolveHumanGateDisposition({
        humanGate: "auto_pass",
        onStuck: "ship_with_warning",
        hasSafeDefault: true,
        evidenceReady: false,
      }),
    ).toEqual({ action: "ship_with_warning" });
    // No safe default to ship onto → fall back to escalate-pause.
    expect(
      resolveHumanGateDisposition({
        humanGate: "auto_pass",
        onStuck: "ship_with_warning",
        hasSafeDefault: false,
        evidenceReady: false,
      }),
    ).toEqual({ action: "pause", assign: true });
  });

  it("onStuck=notify_only pauses WITHOUT an assignment", () => {
    expect(
      resolveHumanGateDisposition({
        humanGate: "auto_pass",
        onStuck: "notify_only",
        hasSafeDefault: true,
        evidenceReady: false,
      }),
    ).toEqual({ action: "pause", assign: false });
  });
});

describe("Phase C snapshot resolvers (fail-closed)", () => {
  it("promotionFromSnapshot: only unattended auto-promotes; null/malformed → manual", () => {
    expect(promotionFromSnapshot({ preset: "supervised" })).toBe("manual");
    expect(promotionFromSnapshot({ preset: "assisted" })).toBe("manual");
    expect(promotionFromSnapshot({ preset: "unattended" })).toBe(
      "auto_on_ready",
    );
    expect(promotionFromSnapshot(null)).toBe("manual");
    expect(promotionFromSnapshot({ preset: "bogus" })).toBe("manual");
    expect(promotionFromSnapshot("auto_on_ready")).toBe("manual");
  });

  it("commitsFromSnapshot: unattended squashes; null/malformed → keep_all", () => {
    expect(commitsFromSnapshot({ preset: "supervised" })).toBe("keep_all");
    expect(commitsFromSnapshot({ preset: "unattended" })).toBe("squash_rework");
    expect(
      commitsFromSnapshot({
        preset: "supervised",
        overrides: { commits: "squash_on_promote" },
      }),
    ).toBe("squash_on_promote");
    // defer is an accepted value that behaves as keep_all (no-op) at promote.
    expect(
      commitsFromSnapshot({
        preset: "supervised",
        overrides: { commits: "defer" },
      }),
    ).toBe("defer");
    expect(commitsFromSnapshot(null)).toBe("keep_all");
    expect(
      commitsFromSnapshot({
        preset: "unattended",
        overrides: { commits: "yolo" },
      }),
    ).toBe("keep_all");
  });

  it("dirtyResolveFromSnapshot: assisted/unattended proceed; null/malformed → ask", () => {
    expect(dirtyResolveFromSnapshot({ preset: "supervised" })).toBe("ask");
    expect(dirtyResolveFromSnapshot({ preset: "assisted" })).toBe("proceed");
    expect(dirtyResolveFromSnapshot({ preset: "unattended" })).toBe("proceed");
    expect(
      dirtyResolveFromSnapshot({
        preset: "supervised",
        overrides: { dirtyResolve: "commit" },
      }),
    ).toBe("commit");
    expect(dirtyResolveFromSnapshot(null)).toBe("ask");
    expect(dirtyResolveFromSnapshot("proceed")).toBe("ask");
  });
});

describe("budgetFromSnapshot (run snapshot → budget axis, fail-OPEN)", () => {
  it("null / undefined / garbage snapshot → {} (unlimited, the safety-axis inversion)", () => {
    expect(budgetFromSnapshot(null)).toEqual({});
    expect(budgetFromSnapshot(undefined)).toEqual({});
    expect(budgetFromSnapshot({})).toEqual({});
    expect(budgetFromSnapshot("budget")).toEqual({});
    expect(budgetFromSnapshot({ preset: "bogus" })).toEqual({});
  });

  it("every preset with no budget override resolves to {} (all-unset)", () => {
    expect(budgetFromSnapshot({ preset: "supervised" })).toEqual({});
    expect(budgetFromSnapshot({ preset: "assisted" })).toEqual({});
    expect(budgetFromSnapshot({ preset: "unattended" })).toEqual({});
  });

  it("a valid snapshot with a budget override resolves through", () => {
    expect(
      budgetFromSnapshot({
        preset: "unattended",
        overrides: { budget: { tree: { maxTokens: 5000, warnAtPct: 75 } } },
      }),
    ).toEqual({ tree: { maxTokens: 5000, warnAtPct: 75 } });
  });

  it("a present-but-invalid budget value fails OPEN to {} (never ADDS a constraint)", () => {
    // A non-positive token ceiling is rejected by budgetAxisSchema; the whole
    // snapshot fails the strict parse → {} (unlimited), never a partial limit.
    expect(
      budgetFromSnapshot({
        preset: "supervised",
        overrides: { budget: { run: { maxTokens: -1 } } },
      }),
    ).toEqual({});
    expect(
      budgetFromSnapshot({
        preset: "supervised",
        overrides: { budget: { run: { warnAtPct: 200 } } },
      }),
    ).toEqual({});
  });
});

describe("applyDefaultBudgetForUnattended (launch auto-fill, never throws)", () => {
  const ENV = "MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS";
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env[ENV];
  });

  afterEach(() => {
    if (prior === undefined) delete process.env[ENV];
    else process.env[ENV] = prior;
  });

  it("unattended + no budget + env set → fills tree.maxTokens", () => {
    process.env[ENV] = "250000";

    const out = applyDefaultBudgetForUnattended({ preset: "unattended" });

    expect(out.overrides?.budget?.tree?.maxTokens).toBe(250000);
    // does not clobber the preset
    expect(out.preset).toBe("unattended");
  });

  it("preserves existing non-budget overrides while merging the budget fill", () => {
    process.env[ENV] = "100";

    const out = applyDefaultBudgetForUnattended({
      preset: "unattended",
      overrides: { commits: "defer" },
    });

    expect(out.overrides?.commits).toBe("defer");
    expect(out.overrides?.budget?.tree?.maxTokens).toBe(100);
  });

  it("unattended + a budget already set (any scope) → unchanged", () => {
    process.env[ENV] = "999";

    const policy: ExecutionPolicy = {
      preset: "unattended",
      overrides: { budget: { run: { maxTokens: 42 } } },
    };

    expect(applyDefaultBudgetForUnattended(policy)).toBe(policy);
  });

  it("non-unattended + env set → unchanged", () => {
    process.env[ENV] = "999";

    const supervised: ExecutionPolicy = { preset: "supervised" };
    const assisted: ExecutionPolicy = { preset: "assisted" };

    expect(applyDefaultBudgetForUnattended(supervised)).toBe(supervised);
    expect(applyDefaultBudgetForUnattended(assisted)).toBe(assisted);
  });

  it("unattended but env unset / 0 / negative / non-numeric → unchanged", () => {
    const policy: ExecutionPolicy = { preset: "unattended" };

    delete process.env[ENV];
    expect(applyDefaultBudgetForUnattended(policy)).toBe(policy);

    for (const raw of ["0", "-5", "abc", "", "12.5"]) {
      process.env[ENV] = raw;
      expect(applyDefaultBudgetForUnattended(policy)).toBe(policy);
    }
  });

  it("never throws on a malformed env value", () => {
    process.env[ENV] = "not-a-number";

    expect(() =>
      applyDefaultBudgetForUnattended({ preset: "unattended" }),
    ).not.toThrow();
  });
});
