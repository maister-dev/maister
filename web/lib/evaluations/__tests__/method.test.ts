import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  evaluationMethodSchema,
  AGGREGATION_ALGORITHMS,
  OBJECTIVE_CHECK_PROVIDERS,
} from "../method-schema";
import {
  loadEvaluationMethod,
  normalizeEvaluationMethodDefinition,
  checkMethodEngineCompatibility,
} from "../method";

import { isMaisterError } from "@/lib/errors";
import { maisterPackageManifestSchema } from "@/lib/config.schema";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function validDefinition(): z.input<typeof evaluationMethodSchema> {
  return {
    schemaVersion: 1,
    id: "sdd-quality",
    name: "SDD Quality",
    modes: ["absolute", "n_way"],
    evidence: { captureBudgetBytes: 1000, requiredCoverage: ["diff"] },
    objectiveChecks: [
      { id: "gates", provider: "gate_result@1", policy: "metric" },
    ],
    criteria: [
      {
        id: "correctness",
        name: "Correctness",
        weight: 3,
        scale: { min: 0, max: 5 },
        anchors: [
          { score: 0, label: "bad" },
          { score: 5, label: "good" },
        ],
      },
      {
        id: "clarity",
        name: "Clarity",
        weight: 1,
        scale: { min: 0, max: 5 },
        anchors: [
          { score: 0, label: "bad" },
          { score: 5, label: "good" },
        ],
      },
    ],
    judges: {
      roles: [
        { id: "reviewer", name: "Reviewer", count: 3, promptTemplate: "p.md" },
      ],
      resultSchema: "r.json",
    },
    aggregation: { algorithm: "weighted_mean@1" },
    panelPolicy: {
      quorum: 2,
      timeoutSeconds: 600,
      disagreement: { scoreSpreadThreshold: 1.5 },
    },
  };
}

describe("evaluationMethodSchema (structural)", () => {
  it("accepts a valid definition and applies defaults", () => {
    const parsed = evaluationMethodSchema.safeParse(validDefinition());

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bonuses).toEqual([]);
      expect(parsed.data.report.primaryView).toBe("scoreboard");
      expect(parsed.data.groundTruth.required).toBe(false);
    }
  });

  it("rejects an unknown top-level key (strict)", () => {
    const parsed = evaluationMethodSchema.safeParse({
      ...validDefinition(),
      surprise: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("requires at least one mode and one criterion", () => {
    expect(
      evaluationMethodSchema.safeParse({ ...validDefinition(), modes: [] })
        .success,
    ).toBe(false);
    expect(
      evaluationMethodSchema.safeParse({ ...validDefinition(), criteria: [] })
        .success,
    ).toBe(false);
  });

  it("rejects an aggregation algorithm outside the closed registry", () => {
    const parsed = evaluationMethodSchema.safeParse({
      ...validDefinition(),
      aggregation: { algorithm: "pairwise_tournament@1" },
    });

    expect(parsed.success).toBe(false);
    expect(AGGREGATION_ALGORITHMS).not.toContain("pairwise_tournament@1");
  });

  it("rejects an objective-check provider outside the closed registry", () => {
    const parsed = evaluationMethodSchema.safeParse({
      ...validDefinition(),
      objectiveChecks: [{ id: "x", provider: "run_shell@1", policy: "metric" }],
    });

    expect(parsed.success).toBe(false);
    expect(OBJECTIVE_CHECK_PROVIDERS).not.toContain("run_shell@1");
  });

  it("requires a hostCheckProfile for trusted_host_check@1", () => {
    const parsed = evaluationMethodSchema.safeParse({
      ...validDefinition(),
      objectiveChecks: [
        { id: "build", provider: "trusted_host_check@1", policy: "gate" },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects non-positive criterion weights and non-positive quorum", () => {
    const badWeight = validDefinition();

    badWeight.criteria[0].weight = 0;
    expect(evaluationMethodSchema.safeParse(badWeight).success).toBe(false);

    const badQuorum = validDefinition();

    badQuorum.panelPolicy.quorum = 0;
    expect(evaluationMethodSchema.safeParse(badQuorum).success).toBe(false);
  });

  it("rejects an absolute asset path in promptTemplate/resultSchema", () => {
    const abs = validDefinition();

    abs.judges.roles[0].promptTemplate = "/etc/passwd";
    expect(evaluationMethodSchema.safeParse(abs).success).toBe(false);

    const traversal = validDefinition();

    traversal.judges.resultSchema = "../../secret.json";
    expect(evaluationMethodSchema.safeParse(traversal).success).toBe(false);
  });
});

describe("normalizeEvaluationMethodDefinition (semantic)", () => {
  function parse(input: unknown) {
    const parsed = evaluationMethodSchema.safeParse(input);

    if (!parsed.success) throw new Error("fixture should be schema-valid");

    return parsed.data;
  }

  it("normalizes criterion weights to sum to one", () => {
    const criteria = normalizeEvaluationMethodDefinition(
      parse(validDefinition()),
    );
    const sum = criteria.reduce((s, c) => s + c.normalizedWeight, 0);

    expect(sum).toBeCloseTo(1, 10);
    expect(criteria[0].normalizedWeight).toBeCloseTo(0.75, 10);
    expect(criteria[0].weight).toBe(3);
  });

  it("fails when anchors omit a scale endpoint", () => {
    const def = validDefinition();

    def.criteria[0].anchors = [
      { score: 1, label: "a" },
      { score: 4, label: "b" },
    ];
    expect(() => normalizeEvaluationMethodDefinition(parse(def))).toThrowError(
      /scale endpoints/,
    );
  });

  it("fails when an anchor score is outside the scale", () => {
    const def = validDefinition();

    def.criteria[0].anchors = [
      { score: 0, label: "a" },
      { score: 9, label: "b" },
    ];

    try {
      normalizeEvaluationMethodDefinition(parse(def));
      throw new Error("expected throw");
    } catch (err) {
      expect(isMaisterError(err) && err.code).toBe("CONFIG");
    }
  });

  it("fails when itemCap is outside the scale", () => {
    const def = validDefinition();

    def.criteria[0].itemCap = 9;
    expect(() => normalizeEvaluationMethodDefinition(parse(def))).toThrowError(
      /itemCap/,
    );
  });

  it("fails when quorum exceeds total judge attempts", () => {
    const def = validDefinition();

    def.panelPolicy.quorum = 4; // only 3 attempts declared
    expect(() => normalizeEvaluationMethodDefinition(parse(def))).toThrowError(
      /quorum/,
    );
  });

  it("fails when a cap check references an unknown criterion", () => {
    const def = validDefinition();

    def.objectiveChecks = [
      {
        id: "cap-x",
        provider: "gate_result@1",
        policy: "cap",
        criterionId: "nonexistent",
      },
    ];
    expect(() => normalizeEvaluationMethodDefinition(parse(def))).toThrowError(
      /unknown criterion/,
    );
  });

  it("rejects aggregation params in M46", () => {
    const def = validDefinition();

    def.aggregation = { algorithm: "median@1", params: { k: 1 } };
    expect(() => normalizeEvaluationMethodDefinition(parse(def))).toThrowError(
      /no params/,
    );
  });
});

describe("checkMethodEngineCompatibility", () => {
  function parse(input: unknown) {
    const parsed = evaluationMethodSchema.safeParse(input);

    if (!parsed.success) throw new Error("fixture should be schema-valid");

    return parsed.data;
  }

  it("is compatible when the engine is within the declared range", () => {
    const def = parse({
      ...validDefinition(),
      compat: { engine_min: "3.2.0" },
    });

    expect(checkMethodEngineCompatibility(def).compatible).toBe(true);
  });

  it("refuses a method whose engine_min is above this engine", () => {
    const def = parse({
      ...validDefinition(),
      compat: { engine_min: "4.0.0" },
    });
    const result = checkMethodEngineCompatibility(def);

    expect(result.compatible).toBe(false);
    expect(result.reason).toContain("engine_min");
  });
});

describe("loadEvaluationMethod", () => {
  it("loads the sdd-quality fixture with digests", async () => {
    const method = await loadEvaluationMethod(join(FIXTURES, "sdd-quality"));

    expect(method.definition.id).toBe("sdd-quality");
    expect(method.criteria).toHaveLength(3);
    expect(method.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(method.resultSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(method.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(method.promptDigests)).toContain("prompts/judge.md");
  });

  it("is deterministic — same fixture yields the same content digest", async () => {
    const a = await loadEvaluationMethod(join(FIXTURES, "sdd-quality"));
    const b = await loadEvaluationMethod(join(FIXTURES, "sdd-quality"));

    expect(a.contentDigest).toBe(b.contentDigest);
  });

  it("throws CONFIG when the method directory has no yaml", async () => {
    await expect(
      loadEvaluationMethod(join(FIXTURES, "does-not-exist")),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});

describe("maisterPackageManifestSchema — evaluationMethods", () => {
  it("defaults to [] for a package that predates the entity", () => {
    const parsed = maisterPackageManifestSchema.safeParse({
      schemaVersion: 1,
      name: "core",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.evaluationMethods).toEqual([]);
  });

  it("parses evaluationMethods entries", () => {
    const parsed = maisterPackageManifestSchema.safeParse({
      schemaVersion: 1,
      name: "core",
      evaluationMethods: [
        { id: "sdd-quality", path: "evaluation-methods/sdd-quality" },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.evaluationMethods).toHaveLength(1);
      expect(parsed.data.evaluationMethods[0].id).toBe("sdd-quality");
    }
  });

  it("rejects duplicate evaluationMethods ids (strict)", () => {
    const parsed = maisterPackageManifestSchema.safeParse({
      schemaVersion: 1,
      name: "core",
      evaluationMethods: [
        { id: "dup", path: "a" },
        { id: "dup", path: "b" },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});
