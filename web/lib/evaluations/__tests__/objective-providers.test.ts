import { describe, expect, it } from "vitest";

import {
  evaluateObjectiveCheck,
  splitProviderVersion,
  type ObjectiveCheckSpec,
} from "@/lib/evaluations/objective/providers";

function spec(over: Partial<ObjectiveCheckSpec>): ObjectiveCheckSpec {
  return {
    id: "c",
    provider: "gate_result@1",
    policy: "gate",
    ...over,
  };
}

describe("splitProviderVersion", () => {
  it("splits id@version", () => {
    expect(splitProviderVersion("gate_result@1")).toEqual({
      checkId: "gate_result",
      version: "1",
    });
  });
});

describe("gate_result provider", () => {
  it("passes only when recorded gates all passed", () => {
    expect(
      evaluateObjectiveCheck(spec({}), {
        gateResults: [{ gateId: "g", status: "passed" }],
      }).status,
    ).toBe("passed");
  });

  it("fails when any recorded gate failed", () => {
    const out = evaluateObjectiveCheck(spec({}), {
      gateResults: [{ gateId: "lint", status: "failed" }],
    });

    expect(out.status).toBe("failed");
    expect(out.reason).toContain("lint");
  });

  it("is not_run (with reason) when no gate facts were captured", () => {
    const out = evaluateObjectiveCheck(spec({}), {});

    expect(out.status).toBe("not_run");
    expect(out.reason).toBeTruthy();
  });

  it("is not_run when the Run declared zero gates", () => {
    expect(evaluateObjectiveCheck(spec({}), { gateResults: [] }).status).toBe(
      "not_run",
    );
  });
});

describe("schema_contract provider never infers PASS from absence", () => {
  it("is unavailable (not passed) when no validation was recorded", () => {
    const out = evaluateObjectiveCheck(
      spec({ provider: "schema_contract@1", policy: "gate" }),
      {},
    );

    expect(out.status).toBe("unavailable");
    expect(out.reason).toBeTruthy();
  });

  it("fails on recorded invalidity", () => {
    const out = evaluateObjectiveCheck(
      spec({ provider: "schema_contract@1", policy: "gate" }),
      { schemaContract: { valid: false, errors: ["missing field x"] } },
    );

    expect(out.status).toBe("failed");
  });
});

describe("diff_stats metric provider", () => {
  it("measures the diff manifest counts", () => {
    const out = evaluateObjectiveCheck(
      spec({ provider: "diff_stats@1", policy: "metric" }),
      { diffStats: { files: 3, additions: 40, deletions: 5 } },
    );

    expect(out.status).toBe("passed");
    expect(out.metric?.value).toEqual({
      files: 3,
      additions: 40,
      deletions: 5,
    });
  });

  it("is unavailable when no manifest was captured", () => {
    expect(
      evaluateObjectiveCheck(
        spec({ provider: "diff_stats@1", policy: "metric" }),
        {},
      ).status,
    ).toBe("unavailable");
  });
});

describe("trusted_host_check never passes from source appearance", () => {
  it("is unavailable when the named host profile is not registered", () => {
    const out = evaluateObjectiveCheck(
      spec({
        provider: "trusted_host_check@1",
        policy: "gate",
        hostCheckProfile: "build",
      }),
      { registeredHostProfiles: new Set() },
    );

    expect(out.status).toBe("unavailable");
    expect(out.status).not.toBe("passed");
  });

  it("is not_run (result pending) when the profile is registered but uncaptured", () => {
    const out = evaluateObjectiveCheck(
      spec({
        provider: "trusted_host_check@1",
        policy: "gate",
        hostCheckProfile: "build",
      }),
      { registeredHostProfiles: new Set(["build"]) },
    );

    expect(out.status).toBe("not_run");
  });
});
