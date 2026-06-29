import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { reworkSchema } from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";

// ADR-118: two optional `rework` fields — `onExhaustion` (a transition key the
// loop node routes to on exhaustion) and `resetTargets` (loop nodes whose attempt
// counter a human rework re-baselines). Schema + engine-floor (>= 2.1.0) only;
// compile-time graph validation is covered separately.

describe("reworkSchema — onExhaustion / resetTargets fields (ADR-118)", () => {
  const base = {
    allowedTargets: ["implement"],
    workspacePolicies: ["keep"],
    maxLoops: 3,
  };

  it("accepts a rework block WITHOUT the new fields (back-compat)", () => {
    expect(reworkSchema.safeParse(base).success).toBe(true);
  });

  it("accepts onExhaustion as a non-empty string", () => {
    expect(
      reworkSchema.safeParse({ ...base, onExhaustion: "exhausted" }).success,
    ).toBe(true);
  });

  it("rejects an empty onExhaustion string", () => {
    expect(reworkSchema.safeParse({ ...base, onExhaustion: "" }).success).toBe(
      false,
    );
  });

  it("rejects a non-string onExhaustion", () => {
    expect(reworkSchema.safeParse({ ...base, onExhaustion: 1 }).success).toBe(
      false,
    );
  });

  it("accepts resetTargets as a non-empty string array", () => {
    expect(
      reworkSchema.safeParse({ ...base, resetTargets: ["verify"] }).success,
    ).toBe(true);
  });

  it("rejects an empty resetTargets array", () => {
    expect(reworkSchema.safeParse({ ...base, resetTargets: [] }).success).toBe(
      false,
    );
  });

  it("rejects a resetTargets entry that is an empty string", () => {
    expect(reworkSchema.safeParse({ ...base, resetTargets: [""] }).success).toBe(
      false,
    );
  });

  it("rejects a non-array resetTargets", () => {
    expect(
      reworkSchema.safeParse({ ...base, resetTargets: "verify" }).success,
    ).toBe(false);
  });
});

describe("engine gate — onExhaustion/resetTargets require engine_min >= 2.1.0 (ADR-118)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "rework-reset-engine-gate-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function load(
    manifest: unknown,
  ): Promise<{ ok: boolean; code?: string }> {
    const path = join(workDir, "flow.yaml");

    await writeFile(path, stringifyYaml(manifest), "utf8");
    try {
      await loadFlowManifest(path);

      return { ok: true };
    } catch (err) {
      return { ok: false, code: isMaisterError(err) ? err.code : "UNKNOWN" };
    }
  }

  function onExhaustionManifest(engineMin: string): unknown {
    return {
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: engineMin },
      nodes: [
        {
          id: "a",
          type: "ai_coding",
          action: { prompt: "x" },
          rework: {
            allowedTargets: ["a"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            onExhaustion: "redo",
          },
          transitions: { success: "done", redo: "done" },
        },
      ],
    };
  }

  function resetTargetsManifest(engineMin: string): unknown {
    return {
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: engineMin },
      nodes: [
        {
          id: "a",
          type: "ai_coding",
          action: { prompt: "x" },
          rework: {
            allowedTargets: ["a"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            resetTargets: ["a"],
          },
          transitions: { success: "done" },
        },
      ],
    };
  }

  it("rejects onExhaustion with engine_min 2.0.0 (CONFIG)", async () => {
    const r = await load(onExhaustionManifest("2.0.0"));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("accepts onExhaustion with engine_min 2.1.0", async () => {
    expect((await load(onExhaustionManifest("2.1.0"))).ok).toBe(true);
  });

  it("rejects resetTargets with engine_min 2.0.0 (CONFIG)", async () => {
    const r = await load(resetTargetsManifest("2.0.0"));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("accepts resetTargets with engine_min 2.1.0", async () => {
    expect((await load(resetTargetsManifest("2.1.0"))).ok).toBe(true);
  });

  it("a flow declaring neither stays valid at its old floor (1.2.0)", async () => {
    const r = await load({
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "a",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    });

    expect(r.ok).toBe(true);
  });
});
