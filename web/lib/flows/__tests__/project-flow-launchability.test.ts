import { describe, expect, it } from "vitest";

import {
  isProjectFlowLaunchable,
  type ProjectFlowLaunchabilityInput,
} from "@/lib/flows/project-flow-launchability";

const manifest = {
  schemaVersion: 1,
  name: "launchable-flow",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "Implement the change" },
    },
  ],
};

const launchableFlow: ProjectFlowLaunchabilityInput = {
  enabledRevisionId: "revision-1",
  enablementState: "Enabled",
  hasReadyRunner: true,
  revision: {
    engineMax: null,
    engineMin: "1.1.0",
    manifest,
    packageStatus: "Installed",
    schemaVersion: 1,
    setupStatus: "not_required",
  },
  trustStatus: "trusted_by_policy",
};

type LaunchabilityOverride = Omit<
  Partial<ProjectFlowLaunchabilityInput>,
  "revision"
> & {
  revision?: Partial<NonNullable<ProjectFlowLaunchabilityInput["revision"]>>;
};

const nonLaunchableCases: readonly [string, LaunchabilityOverride][] = [
  ["an untrusted package", { trustStatus: "untrusted" }],
  ["a disabled package", { enablementState: "Installed" }],
  ["a missing enabled revision", { enabledRevisionId: null }],
  ["an uninstalled revision", { revision: { packageStatus: "Failed" } }],
  ["a failed setup", { revision: { setupStatus: "failed" } }],
  [
    "an incompatible manifest",
    { revision: { manifest: { ...manifest, steps: [] } } },
  ],
  ["no ready runner", { hasReadyRunner: false }],
];

describe("isProjectFlowLaunchable", () => {
  it.each(nonLaunchableCases)("rejects %s", (_reason, override) => {
    const revision = override.revision
      ? { ...launchableFlow.revision!, ...override.revision }
      : launchableFlow.revision;

    expect(
      isProjectFlowLaunchable({ ...launchableFlow, ...override, revision }),
    ).toBe(false);
  });

  it("accepts the complete enablement, trust, compatibility, and runner predicate", () => {
    expect(isProjectFlowLaunchable(launchableFlow)).toBe(true);
  });
});
