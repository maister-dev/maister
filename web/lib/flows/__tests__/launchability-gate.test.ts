import { describe, expect, it } from "vitest";

import {
  describeFlowLaunchabilityRefusal,
  evaluateFlowLaunchability,
} from "@/lib/flows/launchability-gate";

// The ONE launchability decision. The canonical launcher (`launchRunStaged`),
// the delegation trust resolver (`resolveDelegatableFlow`) and the board
// projection (`isProjectFlowLaunchable`) all used to carry their own copy of
// these eight checks; the messages below are the launcher's, verbatim, because
// the ext refusal tests pin them.

const LAUNCHABLE_FLOW = {
  enabledRevisionId: "rev-1",
  enablementState: "Enabled",
  trustStatus: "trusted",
};

const INSTALLED_REVISION = {
  packageStatus: "Installed",
  setupStatus: "done",
  schemaVersion: 1,
  engineMin: null,
  engineMax: null,
};

describe("evaluateFlowLaunchability", () => {
  it("admits an Enabled, trusted flow on an Installed, set-up, compatible revision", () => {
    expect(
      evaluateFlowLaunchability(LAUNCHABLE_FLOW, INSTALLED_REVISION),
    ).toEqual({ ok: true });
  });

  it("also admits UpdateAvailable (the enabled pointer is still live)", () => {
    expect(
      evaluateFlowLaunchability(
        { ...LAUNCHABLE_FLOW, enablementState: "UpdateAvailable" },
        INSTALLED_REVISION,
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    {
      name: "no enabled revision pointer",
      flow: { ...LAUNCHABLE_FLOW, enabledRevisionId: null },
      revision: INSTALLED_REVISION,
      code: "PRECONDITION",
      reason: "no_enabled_revision",
      message: 'flow "bugfix" has no enabled package revision',
    },
    {
      name: "Installed but not enabled",
      flow: { ...LAUNCHABLE_FLOW, enablementState: "Installed" },
      revision: INSTALLED_REVISION,
      code: "PRECONDITION",
      reason: "not_launchable",
      message:
        'flow "bugfix" package is Installed, not launchable (enable it first)',
    },
    {
      name: "untrusted package",
      flow: { ...LAUNCHABLE_FLOW, trustStatus: "untrusted" },
      revision: INSTALLED_REVISION,
      code: "PRECONDITION",
      reason: "untrusted",
      message:
        'flow "bugfix" package is not trusted — confirm trust before launch',
    },
    {
      name: "revision row missing",
      flow: LAUNCHABLE_FLOW,
      revision: null,
      code: "PRECONDITION",
      reason: "revision_row_missing",
      message: 'enabled revision not found for flow "bugfix"',
    },
    {
      name: "revision not Installed",
      flow: LAUNCHABLE_FLOW,
      revision: { ...INSTALLED_REVISION, packageStatus: "Failed" },
      code: "PRECONDITION",
      reason: "revision_not_installed",
      message: 'flow "bugfix" enabled revision is Failed, not Installed',
    },
    {
      name: "setup pending",
      flow: LAUNCHABLE_FLOW,
      revision: { ...INSTALLED_REVISION, setupStatus: "pending" },
      code: "PRECONDITION",
      reason: "setup_incomplete",
      message: 'flow "bugfix" package setup is pending',
    },
    {
      name: "setup failed",
      flow: LAUNCHABLE_FLOW,
      revision: { ...INSTALLED_REVISION, setupStatus: "failed" },
      code: "PRECONDITION",
      reason: "setup_incomplete",
      message: 'flow "bugfix" package setup is failed',
    },
    {
      name: "unsupported manifest schemaVersion",
      flow: LAUNCHABLE_FLOW,
      revision: { ...INSTALLED_REVISION, schemaVersion: 99 },
      code: "CONFIG",
      reason: "unsupported_schema_version",
      message: 'flow "bugfix" requires unsupported manifest schemaVersion 99',
    },
    {
      name: "engine range above this engine",
      flow: LAUNCHABLE_FLOW,
      revision: { ...INSTALLED_REVISION, engineMin: "99.0.0" },
      code: "CONFIG",
      reason: "engine_incompatible",
      message: 'flow "bugfix" is incompatible with this MAIster engine: ',
    },
  ])(
    "refuses $name with $code / $reason and the launcher's message",
    ({ flow, revision, code, reason, message }) => {
      const verdict = evaluateFlowLaunchability(flow, revision);

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;

      expect(verdict.code).toBe(code);
      expect(verdict.reason).toBe(reason);
      expect(describeFlowLaunchabilityRefusal("bugfix", verdict)).toContain(
        message,
      );
    },
  );

  it("checks the flow before the revision, so a disabled flow on a broken revision names the flow", () => {
    const verdict = evaluateFlowLaunchability(
      { ...LAUNCHABLE_FLOW, enablementState: "Disabled" },
      { ...INSTALLED_REVISION, packageStatus: "Failed" },
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("not_launchable");
  });

  it("an engine refusal carries the incompatibility details the launcher attaches", () => {
    const verdict = evaluateFlowLaunchability(LAUNCHABLE_FLOW, {
      ...INSTALLED_REVISION,
      engineMin: "99.0.0",
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.details).toMatchObject({
      flowManifestIncompatibility: { kind: "engine_incompatible" },
    });
  });
});
