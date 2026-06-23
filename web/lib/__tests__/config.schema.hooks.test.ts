import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import {
  aiCodingSettingsSchema,
  enforcementMapSchema,
  judgeSettingsSchema,
  orchestratorSettingsSchema,
} from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";

// ADR-108 (M40): the seventh capability class `hooks` — the per-tool-call
// guardrail rule declaration on a capability-bearing node's settings.
const fullHooks = {
  disabled: false,
  repetition: { max: 5 },
  noProgress: { maxTurns: 15 },
  pathGuard: { allowedPaths: ["src/**", "tests/**"] },
};

describe("hooks capability class — node settings (ADR-108)", () => {
  it("aiCodingSettingsSchema accepts a full hooks block", () => {
    const parsed = aiCodingSettingsSchema.parse({ hooks: fullHooks });

    expect(parsed.hooks).toEqual(fullHooks);
  });

  it("judgeSettingsSchema accepts a full hooks block", () => {
    expect(judgeSettingsSchema.parse({ hooks: fullHooks }).hooks).toEqual(
      fullHooks,
    );
  });

  it("orchestratorSettingsSchema inherits the hooks block", () => {
    expect(
      orchestratorSettingsSchema.parse({ hooks: fullHooks }).hooks,
    ).toEqual(fullHooks);
  });

  it("accepts a sparse hooks block (only repetition) without injecting defaults", () => {
    const parsed = aiCodingSettingsSchema.parse({
      hooks: { repetition: { max: 3 } },
    });

    // Sparse-default rule: absent keys stay absent (no parse-time defaults).
    expect(parsed.hooks).toEqual({ repetition: { max: 3 } });
  });

  it("accepts an opt-out (disabled: true)", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ hooks: { disabled: true } }),
    ).not.toThrow();
  });

  it("rejects a non-positive repetition.max", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ hooks: { repetition: { max: 0 } } }),
    ).toThrow();
    expect(() =>
      aiCodingSettingsSchema.parse({ hooks: { repetition: { max: -1 } } }),
    ).toThrow();
  });

  it("rejects a non-integer repetition.max", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ hooks: { repetition: { max: 2.5 } } }),
    ).toThrow();
  });

  it("rejects a non-positive noProgress.maxTurns", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ hooks: { noProgress: { maxTurns: 0 } } }),
    ).toThrow();
  });

  it("rejects an empty pathGuard.allowedPaths", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({
        hooks: { pathGuard: { allowedPaths: [] } },
      }),
    ).toThrow();
  });

  it("accepts pathGuard opt-in without allowedPaths (env-default fallback)", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ hooks: { pathGuard: {} } }),
    ).not.toThrow();
  });

  it("rejects an unknown key inside the hooks block (strict)", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({
        hooks: { lifecycle: "pre_tool_call" },
      }),
    ).toThrow();
  });

  it("enforcementMapSchema accepts a hooks intent", () => {
    expect(enforcementMapSchema.parse({ hooks: "strict" })).toEqual({
      hooks: "strict",
    });
  });

  it("enforcementMapSchema rejects an unknown hooks intent value", () => {
    expect(() => enforcementMapSchema.parse({ hooks: "bogus" })).toThrow();
  });
});

describe("engine gate — node settings.hooks requires engine_min >= 1.8.0 (ADR-108)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hooks-engine-gate-"));
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

  function hooksManifest(engineMin: string): unknown {
    return {
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: engineMin },
      nodes: [
        {
          id: "a",
          type: "ai_coding",
          action: { prompt: "x" },
          settings: { hooks: { repetition: { max: 5 } } },
          transitions: { success: "done" },
        },
      ],
    };
  }

  it("rejects settings.hooks with engine_min 1.7.0 (CONFIG)", async () => {
    const r = await load(hooksManifest("1.7.0"));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("accepts settings.hooks with engine_min 1.8.0", async () => {
    expect((await load(hooksManifest("1.8.0"))).ok).toBe(true);
  });

  it("a flow declaring no hooks stays valid at its old floor (1.2.0)", async () => {
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
