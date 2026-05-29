import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveTrust } from "@/lib/flows/trust";

const ENV = "MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES";

describe("resolveTrust", () => {
  const original = process.env[ENV];

  beforeEach(() => {
    delete process.env[ENV];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("trusts local file:// sources by policy", () => {
    expect(resolveTrust("file:///repos/flow")).toBe("trusted_by_policy");
  });

  it("trusts absolute-path sources by policy", () => {
    expect(resolveTrust("/repos/flow")).toBe("trusted_by_policy");
  });

  it("marks unknown git sources untrusted by default", () => {
    expect(resolveTrust("github.com/random/flow")).toBe("untrusted");
  });

  it("trusts git sources matching a configured prefix", () => {
    process.env[ENV] = "github.com/myorg/, gitlab.com/myorg/";
    expect(resolveTrust("github.com/myorg/maister-flow-bugfix")).toBe(
      "trusted_by_policy",
    );
    expect(resolveTrust("gitlab.com/myorg/x")).toBe("trusted_by_policy");
  });

  it("does not trust a git source outside the configured prefixes", () => {
    process.env[ENV] = "github.com/myorg/";
    expect(resolveTrust("github.com/other/flow")).toBe("untrusted");
  });
});
