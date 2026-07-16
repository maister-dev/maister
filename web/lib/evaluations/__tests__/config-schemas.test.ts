import { describe, expect, it } from "vitest";

import {
  createPanelBodySchema,
  createProfileBodySchema,
  patchPanelBodySchema,
  putOverrideBodySchema,
  toEvaluationProfileDto,
  toJudgePanelDto,
} from "@/lib/evaluations/config-schemas";

const VALID_POLICY = {
  attempts: 3,
  maxParallelAttempts: 2,
  quorum: 2,
  timeoutMs: 60_000,
  maxRetries: 1,
  blindLabels: true,
  randomizeOrder: true,
  allowedMcps: [],
};

describe("panel body schema", () => {
  it("accepts a well-formed panel", () => {
    const parsed = createPanelBodySchema.safeParse({
      name: "Default",
      roleBindings: [{ role: "judge", agentId: "core:judge" }],
      policy: VALID_POLICY,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects quorum greater than attempts", () => {
    const parsed = createPanelBodySchema.safeParse({
      name: "Bad",
      roleBindings: [{ role: "judge", agentId: "core:judge" }],
      policy: { ...VALID_POLICY, quorum: 9 },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const parsed = createPanelBodySchema.safeParse({
      name: "X",
      roleBindings: [{ role: "judge", agentId: "core:judge" }],
      policy: VALID_POLICY,
      installedPath: "/tmp/secret",
    });

    expect(parsed.success).toBe(false);
  });

  it("requires at least one field on patch", () => {
    expect(patchPanelBodySchema.safeParse({}).success).toBe(false);
    expect(patchPanelBodySchema.safeParse({ enabled: false }).success).toBe(
      true,
    );
  });
});

describe("profile + override body schema", () => {
  it("accepts allowed-override entries as true or numeric bounds", () => {
    const parsed = createProfileBodySchema.safeParse({
      name: "P",
      methodRevisionId: "m1",
      panelId: "p1",
      allowedOverrides: { attempts: { min: 1, max: 9 }, blindLabels: true },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a non-number/boolean override value", () => {
    expect(
      putOverrideBodySchema.safeParse({ overrides: { attempts: "5" } }).success,
    ).toBe(false);
    expect(
      putOverrideBodySchema.safeParse({ overrides: { attempts: 5 } }).success,
    ).toBe(true);
  });
});

describe("DTO projections never leak server-only fields", () => {
  it("panel DTO exposes exactly the config surface", () => {
    const dto = toJudgePanelDto({
      id: "p1",
      name: "N",
      revision: 2,
      roleBindings: [],
      policy: {},
      enabled: true,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      createdByUserId: "u1",
    });

    expect(Object.keys(dto).sort()).toEqual(
      [
        "enabled",
        "id",
        "name",
        "policy",
        "revision",
        "roleBindings",
        "updatedAt",
      ].sort(),
    );
    expect(JSON.stringify(dto)).not.toContain("createdByUserId");
  });

  it("profile DTO exposes exactly the config surface", () => {
    const dto = toEvaluationProfileDto({
      id: "pr1",
      name: "N",
      revision: 1,
      methodRevisionId: "m1",
      panelId: "p1",
      defaults: null,
      hardLimits: null,
      allowedOverrides: null,
      enabled: true,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      createdByUserId: "u1",
    });

    expect(dto).not.toHaveProperty("createdByUserId");
    expect(dto.methodRevisionId).toBe("m1");
  });
});
