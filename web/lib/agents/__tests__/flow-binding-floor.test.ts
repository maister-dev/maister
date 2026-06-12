// M34 (ADR-089): the catalog-agent node binding (`settings.agent`) requires
// compat.engine_min >= 1.5.0; manifests without the key stay valid at any
// engine_min. Mirrors the M30 retry_policy floor test shape.

import { describe, expect, it } from "vitest";

import { validateGraphManifest } from "@/lib/config";
import { aiCodingSettingsSchema } from "@/lib/config.schema";

describe("settings.agent schema", () => {
  it("accepts a safe catalog id and rejects path-segment escapes", () => {
    expect(
      aiCodingSettingsSchema.safeParse({ agent: "code-reviewer" }).success,
    ).toBe(true);
    expect(aiCodingSettingsSchema.safeParse({ agent: "../evil" }).success).toBe(
      false,
    );
  });
});

describe("agent-binding engine floor (ADR-089 — 1.5.0)", () => {
  function manifest(engineMin: string, withBinding: boolean) {
    return {
      schemaVersion: 1,
      name: "Bound",
      compat: { engine_min: engineMin },
      nodes: [
        {
          id: "review",
          type: "ai_coding",
          action: { prompt: "/review" },
          transitions: { success: "done" },
          ...(withBinding ? { settings: { agent: "code-reviewer" } } : {}),
        },
      ],
    } as never;
  }

  function nodesOf(m: never): never {
    return (m as { nodes: unknown }).nodes as never;
  }

  it("rejects a manifest binding an agent with engine_min < 1.5.0", () => {
    const m = manifest("1.4.0", true);

    expect(() =>
      validateGraphManifest(m, nodesOf(m), "/tmp/flow.yaml"),
    ).toThrowError(/settings\.agent.*1\.5\.0|engine_min/);
  });

  it("accepts the same manifest at engine_min 1.5.0", () => {
    const m = manifest("1.5.0", true);

    expect(() =>
      validateGraphManifest(m, nodesOf(m), "/tmp/flow.yaml"),
    ).not.toThrow();
  });

  it("manifests without the binding stay valid at older engine_min", () => {
    const m = manifest("1.1.0", false);

    expect(() =>
      validateGraphManifest(m, nodesOf(m), "/tmp/flow.yaml"),
    ).not.toThrow();
  });
});
