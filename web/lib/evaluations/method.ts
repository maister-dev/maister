import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";
import { parse as parseYaml } from "yaml";

import { sha256, stableStringify } from "./digest";
import {
  EVALUATION_METHOD_FILENAME,
  evaluationMethodSchema,
  type EvaluationMethodDefinition,
} from "./method-schema";

import { MaisterError } from "@/lib/errors";
import {
  isEngineCompatible,
  MAISTER_ENGINE_VERSION,
} from "@/lib/flows/engine-version";

const log = pino({
  name: "evaluation-method",
  level: process.env.LOG_LEVEL ?? "info",
});

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export interface NormalizedCriterion {
  id: string;
  name: string;
  weight: number;
  normalizedWeight: number;
}

export interface NormalizedEvaluationMethod {
  definition: EvaluationMethodDefinition;
  criteria: NormalizedCriterion[];
  definitionDigest: string;
  promptDigests: Record<string, string>;
  resultSchemaDigest: string;
  contentDigest: string;
}

// Pure cross-field semantic validation over a schema-valid definition. Every
// failure throws MaisterError("CONFIG"); no file IO. Returns normalized
// criterion weights (raw + summed-to-one).
export function normalizeEvaluationMethodDefinition(
  def: EvaluationMethodDefinition,
): NormalizedCriterion[] {
  const fail = (message: string): never => {
    throw new MaisterError(
      "CONFIG",
      `${EVALUATION_METHOD_FILENAME} (${def.id}) invalid: ${message}`,
    );
  };

  const criterionIds = new Set<string>();

  for (const c of def.criteria) {
    if (criterionIds.has(c.id)) fail(`duplicate criterion id "${c.id}"`);
    criterionIds.add(c.id);

    const scores = c.anchors.map((a) => a.score);
    const uniqueScores = new Set(scores);

    if (uniqueScores.size !== scores.length) {
      fail(`criterion "${c.id}" has duplicate anchor scores`);
    }
    for (const s of scores) {
      if (s < c.scale.min || s > c.scale.max) {
        fail(
          `criterion "${c.id}" anchor score ${s} outside scale [${c.scale.min}, ${c.scale.max}]`,
        );
      }
    }
    if (!uniqueScores.has(c.scale.min) || !uniqueScores.has(c.scale.max)) {
      fail(
        `criterion "${c.id}" anchors must include the scale endpoints ${c.scale.min} and ${c.scale.max}`,
      );
    }
    if (
      c.itemCap !== undefined &&
      (c.itemCap < c.scale.min || c.itemCap > c.scale.max)
    ) {
      fail(
        `criterion "${c.id}" itemCap ${c.itemCap} outside scale [${c.scale.min}, ${c.scale.max}]`,
      );
    }

    const subIds = new Set<string>();

    for (const sub of c.subcriteria) {
      if (subIds.has(sub.id)) {
        fail(`criterion "${c.id}" duplicate subcriterion id "${sub.id}"`);
      }
      subIds.add(sub.id);
    }
  }

  for (const check of def.objectiveChecks) {
    if (check.criterionId && !criterionIds.has(check.criterionId)) {
      fail(
        `objective check "${check.id}" references unknown criterion "${check.criterionId}"`,
      );
    }
  }

  const totalJudgeAttempts = def.judges.roles.reduce(
    (sum, role) => sum + role.count,
    0,
  );

  if (def.panelPolicy.quorum > totalJudgeAttempts) {
    fail(
      `quorum ${def.panelPolicy.quorum} exceeds total judge attempts ${totalJudgeAttempts}`,
    );
  }

  if (def.caps.totalMax !== undefined && def.caps.totalMax <= 0) {
    fail(`caps.totalMax must be positive`);
  }

  // M46 aggregation algorithms take no required params; reject unknown keys to
  // keep the closed registry honest (ADR-143 D13).
  const paramKeys = Object.keys(def.aggregation.params);

  if (paramKeys.length > 0) {
    fail(
      `aggregation ${def.aggregation.algorithm} accepts no params in M46 (got: ${paramKeys.join(", ")})`,
    );
  }

  const weightSum = def.criteria.reduce((sum, c) => sum + c.weight, 0);

  if (weightSum <= 0) fail("criterion weights must sum to a positive value");

  return def.criteria.map((c) => ({
    id: c.id,
    name: c.name,
    weight: c.weight,
    normalizedWeight: c.weight / weightSum,
  }));
}

export interface EngineCompatibility {
  compatible: boolean;
  reason?: string;
}

// Whether the running engine satisfies the method's declared compat range
// (ADR-143). A method that predates or postdates this engine is refused loudly.
export function checkMethodEngineCompatibility(
  def: EvaluationMethodDefinition,
): EngineCompatibility {
  const result = isEngineCompatible(
    def.compat.engine_min,
    def.compat.engine_max,
  );

  if (result.compatible) return { compatible: true };

  return {
    compatible: false,
    reason:
      result.reason ??
      `engine ${MAISTER_ENGINE_VERSION} incompatible with method ${def.id}`,
  };
}

// Lightweight JSON-Schema structural check (no ajv dependency). The referenced
// judge result schema must be a JSON object declaring at least one schema
// keyword — enough to reject prose/YAML/empty files without a meta-validator.
function assertLooksLikeJsonSchema(parsed: unknown, methodId: string): void {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MaisterError(
      "CONFIG",
      `method ${methodId} result schema must be a JSON object`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const schemaKeywords = [
    "$schema",
    "type",
    "properties",
    "$ref",
    "allOf",
    "anyOf",
    "oneOf",
  ];

  if (!schemaKeywords.some((k) => k in obj)) {
    throw new MaisterError(
      "CONFIG",
      `method ${methodId} result schema declares no schema keyword (${schemaKeywords.join("/")})`,
    );
  }
}

// Loads + validates `<methodRoot>/evaluation-method.yaml` plus its referenced
// prompt/schema assets. INERT: no package content executes. Every failure is
// CONFIG so callers branch on one code. Returns a normalized method with
// content digests (the method version is the package install versionLabel +
// this contentDigest — never a method-local version field; ADR-143 D6).
export async function loadEvaluationMethod(
  methodRoot: string,
): Promise<NormalizedEvaluationMethod> {
  const methodPath = join(methodRoot, EVALUATION_METHOD_FILENAME);
  let raw: string;

  try {
    raw = await readFile(methodPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Cannot read ${EVALUATION_METHOD_FILENAME} at ${methodPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Invalid YAML in ${methodPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  const parsed = evaluationMethodSchema.safeParse(data);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");

    log.warn({ path: methodPath, issues }, "evaluation-method.yaml invalid");
    throw new MaisterError(
      "CONFIG",
      `${EVALUATION_METHOD_FILENAME} invalid at ${methodPath}: ${issues}`,
    );
  }

  const def = parsed.data;
  const criteria = normalizeEvaluationMethodDefinition(def);

  const promptDigests: Record<string, string> = {};

  for (const role of def.judges.roles) {
    if (promptDigests[role.promptTemplate]) continue;
    const promptPath = join(methodRoot, role.promptTemplate);
    let promptText: string;

    try {
      promptText = await readFile(promptPath, "utf8");
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `method ${def.id} prompt template missing: ${role.promptTemplate} (${asError(err).message})`,
        { cause: asError(err) },
      );
    }
    if (promptText.trim().length === 0) {
      throw new MaisterError(
        "CONFIG",
        `method ${def.id} prompt template ${role.promptTemplate} is empty`,
      );
    }
    promptDigests[role.promptTemplate] = sha256(promptText);
  }

  const resultSchemaPath = join(methodRoot, def.judges.resultSchema);
  let resultSchemaText: string;

  try {
    resultSchemaText = await readFile(resultSchemaPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `method ${def.id} result schema missing: ${def.judges.resultSchema} (${asError(err).message})`,
      { cause: asError(err) },
    );
  }

  let resultSchemaParsed: unknown;

  try {
    resultSchemaParsed = JSON.parse(resultSchemaText);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `method ${def.id} result schema ${def.judges.resultSchema} is not valid JSON: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  assertLooksLikeJsonSchema(resultSchemaParsed, def.id);

  const definitionDigest = sha256(stableStringify(def));
  const resultSchemaDigest = sha256(resultSchemaText);
  const contentDigest = sha256(
    stableStringify({
      definitionDigest,
      promptDigests,
      resultSchemaDigest,
    }),
  );

  log.debug(
    {
      methodId: def.id,
      criteria: def.criteria.length,
      judgeRoles: def.judges.roles.length,
      aggregation: def.aggregation.algorithm,
      definitionDigest,
      contentDigest,
    },
    "evaluation method loaded",
  );

  return {
    definition: def,
    criteria,
    definitionDigest,
    promptDigests,
    resultSchemaDigest,
    contentDigest,
  };
}
