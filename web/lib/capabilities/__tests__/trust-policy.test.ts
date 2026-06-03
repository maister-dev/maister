/**
 * T2.6 — resolveCapabilityTrust reads MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES
 * (R-DEPLOY: the new env var is actually consumed) and is independent of the
 * flow-package trust policy.
 */
import { afterEach, describe, expect, it } from "vitest";

import { resolveCapabilityTrust } from "@/lib/capabilities/import";

const CAP = "MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES";
const FLOW = "MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES";

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("resolveCapabilityTrust (M14 T2.6)", () => {
  const originalCap = process.env[CAP];
  const originalFlow = process.env[FLOW];

  afterEach(() => {
    restore(CAP, originalCap);
    restore(FLOW, originalFlow);
  });

  it("local / file:// sources are trusted_by_policy regardless of the env", () => {
    delete process.env[CAP];

    expect(resolveCapabilityTrust("/abs/local/path")).toBe("trusted_by_policy");
    expect(resolveCapabilityTrust("file:///abs/path")).toBe(
      "trusted_by_policy",
    );
  });

  it("a git source matching a configured prefix is trusted_by_policy", () => {
    process.env[CAP] = "github.com/my-org/,gitlab.com/x/";

    expect(resolveCapabilityTrust("github.com/my-org/pkg")).toBe(
      "trusted_by_policy",
    );
  });

  it("a non-matching git source is untrusted", () => {
    process.env[CAP] = "github.com/my-org/";

    expect(resolveCapabilityTrust("github.com/other/pkg")).toBe("untrusted");
  });

  it("empty/unset env → git sources untrusted (only local trusted)", () => {
    delete process.env[CAP];

    expect(resolveCapabilityTrust("github.com/any/pkg")).toBe("untrusted");
  });

  it("does NOT consult the flow-package prefix env (independent policy)", () => {
    delete process.env[CAP];
    process.env[FLOW] = "github.com/my-org/";

    expect(resolveCapabilityTrust("github.com/my-org/pkg")).toBe("untrusted");
  });
});
