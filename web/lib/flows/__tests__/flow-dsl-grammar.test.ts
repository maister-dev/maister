import { describe, expect, it } from "vitest";

import { CONSENSUS_REQUIRED_OUTPUTS, SESSIONS_ENGINE_MIN } from "@/lib/config";
import {
  aiCodingSettingsSchema,
  cliCheckSettingsSchema,
  gateSchema,
  humanSettingsSchema,
  nodeSchema,
  workspacePolicySchema,
} from "@/lib/config.schema";
import { buildFlowDslGrammar } from "@/lib/flows/flow-dsl-grammar";

// --- Zod introspection helpers (config.schema.ts is the SSOT) ----------------
// Zod does not type its internal `_def` for structural walking, so these helpers
// localize the unavoidable casts behind a typed surface instead of leaking `any`.

function def(schema: unknown): Record<string, unknown> {
  return (schema as { _def: Record<string, unknown> })._def;
}

function typeName(schema: unknown): string {
  return def(schema).typeName as string;
}

function unwrap(schema: unknown): unknown {
  let current = schema;

  for (;;) {
    const name = typeName(current);

    if (
      name === "ZodOptional" ||
      name === "ZodNullable" ||
      name === "ZodDefault"
    ) {
      current = def(current).innerType;
    } else if (name === "ZodEffects") {
      current = def(current).schema;
    } else {
      return current;
    }
  }
}

function shapeOf(schema: unknown): Record<string, unknown> {
  return (unwrap(schema) as { shape: Record<string, unknown> }).shape;
}

function unionOptions(schema: unknown): unknown[] {
  return (unwrap(schema) as { options: unknown[] }).options;
}

function enumValues(schema: unknown): string[] {
  const inner = unwrap(schema);
  const name = typeName(inner);

  if (name === "ZodEnum") return [...(inner as { options: string[] }).options];
  if (name === "ZodLiteral") return [String(def(inner).value)];

  throw new Error(`expected enum/literal, got ${name}`);
}

function isNever(schema: unknown): boolean {
  return typeName(unwrap(schema)) === "ZodNever";
}

function nodeTypeOf(option: unknown): string {
  return String(def(shapeOf(option).type).value);
}

function realShapeKeys(schema: unknown): string[] {
  return Object.entries(shapeOf(schema))
    .filter(([, sub]) => !isNever(sub))
    .map(([key]) => key);
}

describe("buildFlowDslGrammar drift guard", () => {
  const grammar = buildFlowDslGrammar();
  const nodeOptions = unionOptions(nodeSchema);
  const consensusNode = nodeOptions.find(
    (option) => nodeTypeOf(option) === "consensus",
  );

  it("introspects every node type from the discriminated union", () => {
    const types = nodeOptions.map(nodeTypeOf);

    expect(types).toEqual(
      expect.arrayContaining([
        "ai_coding",
        "orchestrator",
        "consensus",
        "judge",
        "cli",
        "check",
        "human",
        "form",
      ]),
    );
    expect(consensusNode).toBeDefined();
  });

  it("documents every node type, settings key, and enum value", () => {
    const nodeTypes = nodeOptions.map(nodeTypeOf);

    const settingsKeys = new Set<string>();

    // Derive node `settings` keys from EVERY node option's settings shape so a
    // new node type cannot slip past the guard without a settings block being
    // documented. (consensus carries inline fields, not a `settings` block — its
    // shape is added below alongside the standalone gate schema.)
    for (const option of nodeOptions) {
      const settings = shapeOf(option).settings;

      if (settings !== undefined) {
        for (const key of realShapeKeys(settings)) settingsKeys.add(key);
      }
    }

    for (const schema of [consensusNode, gateSchema]) {
      for (const key of realShapeKeys(schema)) settingsKeys.add(key);
    }

    // Guard against a vacuous derivation: each of these keys exists ONLY in one
    // node type's settings shape, so their presence proves the per-node settings
    // were actually read (not silently skipped).
    expect(settingsKeys).toContain("settingsProfile"); // ai_coding/orchestrator
    expect(settingsKeys).toContain("delegation"); // orchestrator
    expect(settingsKeys).toContain("form_schema"); // form
    expect(settingsKeys).toContain("timeoutMs"); // cli / check
    expect(settingsKeys).toContain("slaHours"); // human

    const enumGroups: Record<string, string[]> = {
      thinkingEffort: enumValues(
        shapeOf(aiCodingSettingsSchema).thinkingEffort,
      ),
      permissionMode: enumValues(
        shapeOf(aiCodingSettingsSchema).permissionMode,
      ),
      workspaceAccess: enumValues(
        shapeOf(aiCodingSettingsSchema).workspaceAccess,
      ),
      workspacePolicy: enumValues(workspacePolicySchema),
      gateKind: enumValues(shapeOf(gateSchema).kind),
      gateMode: enumValues(shapeOf(gateSchema).mode),
      criticality: enumValues(shapeOf(humanSettingsSchema).criticality),
      environmentPolicy: enumValues(
        shapeOf(cliCheckSettingsSchema).environmentPolicy,
      ),
      failureClass: enumValues(shapeOf(cliCheckSettingsSchema).failureClass),
      roundsMode: enumValues(shapeOf(shapeOf(consensusNode).rounds).mode),
      onNoConsensus: enumValues(shapeOf(consensusNode).on_no_consensus),
    };

    const missing: string[] = [];

    for (const type of nodeTypes) {
      if (!grammar.includes(type)) missing.push(`node type: ${type}`);
    }

    for (const key of settingsKeys) {
      if (!grammar.includes(key)) missing.push(`settings key: ${key}`);
    }

    for (const [group, values] of Object.entries(enumGroups)) {
      for (const value of values) {
        if (!grammar.includes(value)) missing.push(`enum ${group}: ${value}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("states consensus is a first-class node", () => {
    expect(grammar).toContain("type: consensus");
    expect(grammar.toLowerCase()).toContain("first-class");
  });

  it("documents the M42 session model + compile invariants", () => {
    // The Zod-shape guard above cannot see top-level `sessions:` (a manifest
    // field, not a node settings key) nor the validateSessions /
    // SESSIONS_ENGINE_MIN invariants (config.ts superRefine/validation) — so
    // assert the grammar mirrors them directly. Drift in either fails here.
    expect(grammar).toContain("sessions:");
    expect(grammar).toContain("session:");
    expect(grammar).toContain(SESSIONS_ENGINE_MIN); // engine floor "2.0.0"
    // unified runner config surfaces
    expect(grammar).toContain("effort");
    expect(grammar).toContain("env:NAME");
    // invariants the loader enforces
    const lower = grammar.toLowerCase();

    expect(lower).toContain("excluded from"); // consensus excluded from sessions:
    expect(lower).toContain("must not declare a"); // consensus session refusal
    expect(lower).toContain("runner-bearing"); // judge is runner-bearing
    expect(lower).toContain("fails to compile"); // undefined session ref
  });

  it("documents the consensus compile-time output contract", () => {
    // validateConsensusOutputs (config.ts) hard-requires these exact produced
    // artifacts via a superRefine the Zod-shape guard above cannot see — so
    // assert the grammar mirrors the contract directly. Drift in either fails here.
    for (const [id, kind] of CONSENSUS_REQUIRED_OUTPUTS) {
      expect(grammar).toContain(id);
      expect(grammar).toContain(kind);
    }
    expect(grammar).toContain("current: true");
  });

  it("documents consensus workspace as an object, not a scalar", () => {
    // consensusWorkspaceSchema is strict `{ mode: "repo_read" }`; without an
    // explicit example the Flow assistant tends to emit `workspace: repo_read`,
    // which validates as a string and gets rejected before apply.
    expect(grammar).toContain("Consensus `workspace` fields are objects");
    expect(grammar).toContain("workspace: { mode: repo_read }");
    expect(grammar).toContain("workspace: repo_read");
    expect(grammar).toContain("runtime expects `{ mode: repo_read }`");
  });

  it("documents assistant prompt-authoring conventions that live outside Zod", () => {
    // These conventions are render-time/storage contracts rather than schema
    // fields, so the Zod introspection guard above cannot detect drift.
    expect(grammar).toContain("@skill:<slug>");
    expect(grammar).toContain("@skill:aif-fix");
    expect(grammar).toContain("@skill:aif-commit");
    expect(grammar).toContain("{{ <path> ?? '<literal>' }}");
    expect(grammar).toContain("{{ executor.router ?? '' }}");
    expect(grammar.toLowerCase()).toContain("optional/conditional");
    expect(grammar).not.toContain("        /aif-fix");
    expect(grammar).not.toContain('prompt: "/aif-commit"');
  });
});
