import { describe, expect, it } from "vitest";

import {
  MAISTER_ENGINE_VERSION,
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";

describe("MAISTER_ENGINE_VERSION", () => {
  it("is 1.6.0 (M36 orchestrator node bump)", () => {
    expect(MAISTER_ENGINE_VERSION).toBe("1.6.0");
  });
});

describe("isEngineCompatible", () => {
  it("is compatible with an open-ended (no bounds) range", () => {
    expect(isEngineCompatible().compatible).toBe(true);
    expect(isEngineCompatible(undefined, undefined).compatible).toBe(true);
  });

  it("is compatible when engine is within [min, max]", () => {
    expect(isEngineCompatible("0.1.0", "2.0.0").compatible).toBe(true);
    expect(
      isEngineCompatible(MAISTER_ENGINE_VERSION, MAISTER_ENGINE_VERSION)
        .compatible,
    ).toBe(true);
  });

  it("is incompatible when engine is below engine_min", () => {
    // Engine is 1.6.0 (M36 bump); a min above it must be rejected.
    const r = isEngineCompatible("1.7.0");

    expect(r.compatible).toBe(false);
    expect(r.reason).toContain("engine_min");
  });

  it("is incompatible when engine is above engine_max", () => {
    const r = isEngineCompatible(undefined, "0.9.0");

    expect(r.compatible).toBe(false);
    expect(r.reason).toContain("engine_max");
  });

  it("is incompatible when a bound is not valid semver", () => {
    expect(isEngineCompatible("not-a-version").compatible).toBe(false);
    expect(isEngineCompatible(undefined, "1.x").compatible).toBe(false);
  });
});

describe("isSchemaVersionSupported", () => {
  it("supports schemaVersion 1 and rejects unknown versions", () => {
    expect(isSchemaVersionSupported(1)).toBe(true);
    expect(isSchemaVersionSupported(2)).toBe(false);
    expect(isSchemaVersionSupported(0)).toBe(false);
  });
});
