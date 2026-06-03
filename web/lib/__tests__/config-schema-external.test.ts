// RED (M16 Phase 4 §A): the additive `gates[].external` manifest block.
//
// Derived from the FROZEN spec — docs/flow-dsl.md §"`gates[].external` block"
// (lines 311-329) and docs/system-analytics/external-operations.md
// §Expectations. The block is OPTIONAL, additive, NO engine bump. It is only
// valid on `kind: external_check`; placing it on any other gate kind is a
// manifest validation error (the project's `CONFIG` failure mode). Unknown keys
// inside `external` are rejected.
//
// These are pure-zod unit tests against `gateSchema.safeParse` — no DB, no I/O.
// `gateSchema` exists today (config.schema.ts ~247) but has NO `external` field,
// so every assertion that exercises the block is RED until the field is added.

import { describe, expect, it } from "vitest";

import { gateSchema } from "@/lib/config.schema";

describe("config.schema — gates[].external block (M16 §A)", () => {
  it("accepts an external_check gate with a full external block", () => {
    const gate = {
      id: "ci",
      kind: "external_check",
      mode: "blocking",
      external: {
        description: "GitHub Actions full test suite on the run branch.",
        staleOnNewCommit: true,
      },
    };

    const parsed = gateSchema.safeParse(gate);

    expect(parsed.success).toBe(true);
  });

  it("accepts an external_check gate with NO external block (additive, backwards-compatible)", () => {
    const gate = {
      id: "ci",
      kind: "external_check",
      mode: "blocking",
    };

    const parsed = gateSchema.safeParse(gate);

    expect(parsed.success).toBe(true);
  });

  it("accepts external with only description (staleOnNewCommit omitted)", () => {
    const gate = {
      id: "ci",
      kind: "external_check",
      mode: "blocking",
      external: { description: "CI suite" },
    };

    expect(gateSchema.safeParse(gate).success).toBe(true);
  });

  it("accepts external with only staleOnNewCommit:false (description omitted)", () => {
    const gate = {
      id: "ci",
      kind: "external_check",
      mode: "blocking",
      external: { staleOnNewCommit: false },
    };

    expect(gateSchema.safeParse(gate).success).toBe(true);
  });

  it("defaults staleOnNewCommit to true when the external block omits it", () => {
    const gate = {
      id: "ci",
      kind: "external_check",
      mode: "blocking",
      external: { description: "CI suite" },
    };

    const parsed = gateSchema.safeParse(gate);

    // The frozen contract pins the default to `true` (docs/flow-dsl.md table).
    // RED until the schema declares `staleOnNewCommit: z.boolean().default(true)`.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        (parsed.data as { external?: { staleOnNewCommit?: boolean } }).external
          ?.staleOnNewCommit,
      ).toBe(true);
    }
  });

  it("rejects an empty-string description (min length 1)", () => {
    const gate = {
      id: "ci",
      kind: "external_check",
      mode: "blocking",
      external: { description: "" },
    };

    expect(gateSchema.safeParse(gate).success).toBe(false);
  });

  it("rejects unknown keys inside the external block", () => {
    const gate = {
      id: "ci",
      kind: "external_check",
      mode: "blocking",
      external: {
        description: "CI suite",
        bogusKey: "nope",
      },
    };

    expect(gateSchema.safeParse(gate).success).toBe(false);
  });

  it("rejects a non-boolean staleOnNewCommit", () => {
    const gate = {
      id: "ci",
      kind: "external_check",
      mode: "blocking",
      external: { staleOnNewCommit: "yes" },
    };

    expect(gateSchema.safeParse(gate).success).toBe(false);
  });

  it("rejects the external block on a command_check gate (CONFIG — wrong kind)", () => {
    const gate = {
      id: "fmt",
      kind: "command_check",
      mode: "blocking",
      command: "pnpm prettier --check .",
      external: { description: "not allowed here" },
    };

    // The block is meaningful only for kind: external_check. On any other kind
    // it is a manifest validation error (CONFIG). RED until cross-field refine.
    expect(gateSchema.safeParse(gate).success).toBe(false);
  });

  it("rejects the external block on an artifact_required gate (CONFIG — wrong kind)", () => {
    const gate = {
      id: "art",
      kind: "artifact_required",
      mode: "blocking",
      inputArtifacts: ["impl-diff"],
      external: { staleOnNewCommit: true },
    };

    expect(gateSchema.safeParse(gate).success).toBe(false);
  });

  it("rejects the external block on a human_review gate (CONFIG — wrong kind)", () => {
    const gate = {
      id: "rev",
      kind: "human_review",
      mode: "blocking",
      external: { description: "nope" },
    };

    expect(gateSchema.safeParse(gate).success).toBe(false);
  });
});
