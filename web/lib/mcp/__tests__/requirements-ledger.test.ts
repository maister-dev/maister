import { describe, expect, it } from "vitest";

import {
  buildRequirementsLedger,
  classifyRequirement,
  deriveDeclaredRefs,
  type RequirementCandidate,
  type RequirementSource,
} from "@/lib/mcp/requirements-ledger";

// ADR-129 (W-A, DEC-2): derived requirements ledger. Aggregation is a pure union
// over package/flow/agent sources with SET/CLEAR/re-SET symmetry; classification
// is a pure function of binding + candidate + trust/readiness state.

const pkg = (name: string, refs: string[]): RequirementSource => ({
  kind: "package",
  packageName: name,
  refs,
});
const flow = (
  id: string,
  required: string[],
  additional: string[],
): RequirementSource => ({ kind: "flow", flowRefId: id, required, additional });
const agent = (id: string, refs: string[]): RequirementSource => ({
  kind: "agent",
  agentId: id,
  refs,
});

describe("deriveDeclaredRefs — aggregation + SET/CLEAR/re-SET symmetry", () => {
  it("aggregates refs across package, flow (required/additional), and agent sources", () => {
    const refs = deriveDeclaredRefs([
      pkg("bugfix", ["github"]),
      flow("dev", ["filesystem"], ["postgres"]),
      agent("triager", ["github"]),
    ]);
    const byRef = new Map(refs.map((r) => [r.refId, r]));

    expect(byRef.get("github")?.required).toBe(true);
    expect(byRef.get("github")?.declaredBy).toEqual([
      "agent:triager",
      "package:bugfix",
    ]);
    expect(byRef.get("filesystem")?.required).toBe(true);
    expect(byRef.get("postgres")?.required).toBe(false); // additional-only
  });

  it("a ref required by ANY source is required even if another lists it additional", () => {
    const refs = deriveDeclaredRefs([
      flow("a", [], ["github"]),
      flow("b", ["github"], []),
    ]);

    expect(refs.find((r) => r.refId === "github")?.required).toBe(true);
  });

  it("dropping the last declaring source DROPS the requirement; re-adding RESTORES it", () => {
    const withSource = deriveDeclaredRefs([
      flow("keep", ["filesystem"], []),
      pkg("bugfix", ["github"]),
    ]);

    expect(withSource.map((r) => r.refId).sort()).toEqual([
      "filesystem",
      "github",
    ]);

    // CLEAR: remove the only source declaring github
    const cleared = deriveDeclaredRefs([flow("keep", ["filesystem"], [])]);

    expect(cleared.map((r) => r.refId)).toEqual(["filesystem"]);
    expect(cleared.some((r) => r.refId === "github")).toBe(false);

    // re-SET: add it back → restored
    const restored = deriveDeclaredRefs([
      flow("keep", ["filesystem"], []),
      pkg("bugfix", ["github"]),
    ]);

    expect(restored.map((r) => r.refId).sort()).toEqual([
      "filesystem",
      "github",
    ]);
  });
});

describe("classifyRequirement", () => {
  const base: RequirementCandidate = {
    refId: "github",
    required: true,
    declaredBy: ["package:bugfix"],
    candidateSources: [],
  };

  it("bound: enabled binding with a present target and no trust/readiness issue", () => {
    expect(
      classifyRequirement({
        ...base,
        binding: {
          targetKind: "platform",
          enabled: true,
          bindableTargetPresent: true,
          overlayValid: true,
        },
      }),
    ).toBe("bound");
  });

  it("misconfigured: enabled binding whose target is missing or overlay invalid", () => {
    expect(
      classifyRequirement({
        ...base,
        binding: {
          targetKind: "platform",
          enabled: true,
          bindableTargetPresent: false,
          overlayValid: true,
        },
      }),
    ).toBe("misconfigured");
    expect(
      classifyRequirement({
        ...base,
        binding: {
          targetKind: "platform",
          enabled: true,
          bindableTargetPresent: true,
          overlayValid: false,
        },
      }),
    ).toBe("misconfigured");
  });

  it("not_ready: bound but trust withheld or probe NotReady", () => {
    expect(
      classifyRequirement({
        ...base,
        binding: {
          targetKind: "platform",
          enabled: true,
          bindableTargetPresent: true,
          overlayValid: true,
        },
        effectiveTrustWithheld: true,
      }),
    ).toBe("not_ready");
  });

  it("unbound: disabled binding (explicit disconnect)", () => {
    expect(
      classifyRequirement({
        ...base,
        binding: {
          targetKind: "platform",
          enabled: false,
          bindableTargetPresent: true,
          overlayValid: true,
        },
      }),
    ).toBe("unbound");
  });

  it("auto: no binding but a candidate record matches (grandfather)", () => {
    expect(
      classifyRequirement({ ...base, candidateSources: ["platform"] }),
    ).toBe("auto");
  });

  it("not_ready: auto candidate whose winner is trust-withheld", () => {
    expect(
      classifyRequirement({
        ...base,
        candidateSources: ["platform"],
        effectiveTrustWithheld: true,
      }),
    ).toBe("not_ready");
  });

  it("unbound: no binding and no candidate", () => {
    expect(classifyRequirement(base)).toBe("unbound");
  });
});

describe("buildRequirementsLedger", () => {
  it("classifies each candidate and preserves declaration metadata", () => {
    const ledger = buildRequirementsLedger([
      {
        refId: "github",
        required: true,
        declaredBy: ["package:bugfix"],
        candidateSources: ["platform"],
      },
    ]);

    expect(ledger).toEqual([
      {
        refId: "github",
        required: true,
        declaredBy: ["package:bugfix"],
        classification: "auto",
      },
    ]);
  });
});
