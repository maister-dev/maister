import { describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors-core";
import {
  assertNoBlindShip,
  blindShipLockedOptions,
  checksFromSnapshot,
  crashRetryFromSnapshot,
  permissionsFromSnapshot,
  defaultExecutionPolicy,
  executionPolicySchema,
  expandExecutionPolicy,
  isBlindShip,
  requiresLaunchUnattended,
  resolveExecutionPolicy,
  reworkExhaustionFromSnapshot,
  type ExecutionPolicy,
} from "@/lib/runs/execution-policy";

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
