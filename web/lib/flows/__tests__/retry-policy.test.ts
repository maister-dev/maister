// M30 (ADR-080): node-level retry_policy — manifest validation. The
// on_errors allow-list is an ALLOW-list ({SPAWN, EXECUTOR_UNAVAILABLE,
// CHECKPOINT, ACP_PROTOCOL}); everything else (PRECONDITION, CONFIG,
// unknown strings) is rejected at parse → CONFIG. attempts >= 1; workspace
// defaults to rewind-to-node-checkpoint. Declaring the key requires
// compat.engine_min >= 1.4.0.

import { describe, expect, it } from "vitest";

import { validateGraphManifest } from "@/lib/config";
import {
  nodeSchema,
  RETRYABLE_ERROR_CODES,
  retryPolicySchema,
} from "@/lib/config.schema";

describe("retryPolicySchema (ADR-080)", () => {
  it("accepts every code on the retryable allow-list", () => {
    for (const code of RETRYABLE_ERROR_CODES) {
      const r = retryPolicySchema.safeParse({
        attempts: 2,
        on_errors: [code],
      });

      expect(r.success).toBe(true);
    }
  });

  it("defaults workspace to rewind-to-node-checkpoint", () => {
    const r = retryPolicySchema.parse({ attempts: 2, on_errors: ["SPAWN"] });

    expect(r.workspace).toBe("rewind-to-node-checkpoint");
  });

  it("rejects non-retryable codes (PRECONDITION, CONFIG) and unknown strings", () => {
    for (const code of ["PRECONDITION", "CONFIG", "TOTALLY_MADE_UP"]) {
      const r = retryPolicySchema.safeParse({
        attempts: 2,
        on_errors: [code],
      });

      expect(r.success).toBe(false);
    }
  });

  it("rejects attempts < 1 and non-integers", () => {
    expect(
      retryPolicySchema.safeParse({ attempts: 0, on_errors: ["SPAWN"] })
        .success,
    ).toBe(false);
    expect(
      retryPolicySchema.safeParse({ attempts: 1.5, on_errors: ["SPAWN"] })
        .success,
    ).toBe(false);
  });

  it("rejects an empty on_errors list", () => {
    expect(
      retryPolicySchema.safeParse({ attempts: 2, on_errors: [] }).success,
    ).toBe(false);
  });
});

describe("context retry selectors", () => {
  it("preserves a reason-only policy and rejects missing, empty, and unknown selectors", () => {
    const policy = {
      attempts: 2,
      workspace: "keep",
      on_reasons: ["context_exhausted"],
    };

    expect(retryPolicySchema.parse(policy)).toEqual(policy);
    expect(
      retryPolicySchema.parse({ ...policy, on_errors: ["SPAWN"] }),
    ).toEqual({
      ...policy,
      on_errors: ["SPAWN"],
    });
    for (const selectors of [
      {},
      { on_reasons: [] },
      { on_reasons: ["protocol"] },
    ]) {
      expect(
        retryPolicySchema.safeParse({ attempts: 2, ...selectors }).success,
      ).toBe(false);
    }
  });

  it("requires the new floor only when declaring reason selectors", () => {
    const nodes = [
      {
        id: "impl",
        type: "ai_coding",
        action: { prompt: "/impl" },
        transitions: { success: "done" },
        retry_policy: {
          attempts: 2,
          workspace: "keep",
          on_reasons: ["context_exhausted"],
        },
      },
    ] as never;
    const check = (engine_min: string) =>
      validateGraphManifest(
        {
          schemaVersion: 1,
          name: "Retry",
          compat: { engine_min },
          nodes,
        } as never,
        nodes,
        "/tmp/flow.yaml",
      );

    expect(() => check("3.12.0")).toThrowError(/3\.13\.0/);
    expect(() => check("3.13.0")).not.toThrow();
  });
});

describe("retry_policy node placement", () => {
  const base = {
    id: "n1",
    transitions: { success: "done" },
  };

  it("is accepted on ai_coding and cli nodes", () => {
    expect(
      nodeSchema.safeParse({
        ...base,
        type: "ai_coding",
        action: { prompt: "/x" },
        retry_policy: { attempts: 2, on_errors: ["SPAWN"] },
      }).success,
    ).toBe(true);
    expect(
      nodeSchema.safeParse({
        ...base,
        type: "cli",
        action: { command: "echo hi" },
        retry_policy: { attempts: 2, on_errors: ["CHECKPOINT"] },
      }).success,
    ).toBe(true);
  });

  it("is stripped (never honored) on human/check/judge nodes", () => {
    // Extension keys are preserved for Flow Studio round-trips, but reserved
    // MAIster policy keys are only honored on the node types that define them.
    const human = nodeSchema.safeParse({
      ...base,
      type: "human",
      retry_policy: { attempts: 2, on_errors: ["SPAWN"] },
    });

    expect(human.success).toBe(true);
    expect(
      (human as { data?: Record<string, unknown> }).data?.retry_policy,
    ).toBeUndefined();

    const check = nodeSchema.safeParse({
      ...base,
      type: "check",
      action: { command: "echo hi" },
      retry_policy: { attempts: 2, on_errors: ["SPAWN"] },
    });

    expect(check.success).toBe(true);
    expect(
      (check as { data?: Record<string, unknown> }).data?.retry_policy,
    ).toBeUndefined();

    const judge = nodeSchema.safeParse({
      ...base,
      type: "judge",
      action: { prompt: "/x" },
      retry_policy: { attempts: 2, on_errors: ["SPAWN"] },
    });

    expect(judge.success).toBe(true);
    expect(
      (judge as { data?: Record<string, unknown> }).data?.retry_policy,
    ).toBeUndefined();
  });
});

describe("retry_policy engine floor (DD9 — 1.4.0)", () => {
  function manifest(engineMin: string) {
    return {
      schemaVersion: 1,
      name: "Retry",
      compat: { engine_min: engineMin },
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "/impl" },
          transitions: { success: "done" },
          retry_policy: { attempts: 2, on_errors: ["SPAWN"] },
        },
      ],
    } as never;
  }

  function nodesOf(m: never): never {
    return (m as { nodes: unknown }).nodes as never;
  }

  it("rejects a manifest declaring retry_policy with engine_min < 1.4.0", () => {
    const m = manifest("1.3.0");

    expect(() =>
      validateGraphManifest(m, nodesOf(m), "/tmp/flow.yaml"),
    ).toThrowError(/engine_min/);
  });

  it("accepts the same manifest at engine_min 1.4.0", () => {
    const m = manifest("1.4.0");

    expect(() =>
      validateGraphManifest(m, nodesOf(m), "/tmp/flow.yaml"),
    ).not.toThrow();
  });
});
