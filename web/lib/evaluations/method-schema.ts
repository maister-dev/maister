import { z } from "zod";

// Portable Evaluation Method content contract (M46, ADR-143). This module is
// the schema for `evaluation-method.yaml` shipped inside a package under
// `evaluation-methods/<id>/`. It is INERT: parsing this file executes no
// package content — capture, prompts, objective checks, and aggregation only
// run for an enabled, trusted, compatible method (ADR-143 D7).
//
// Every aggregation algorithm and objective-check provider a method may name is
// resolved through a CLOSED platform registry — a package can never introduce a
// new executable aggregator or check command (ADR-143 D11/D13). New providers
// are host code changes, deliberately, so evaluation stays deterministic.

export const EVALUATION_METHOD_FILENAME = "evaluation-method.yaml";

// Closed aggregation registry. M46 shipped three scalar algorithms;
// `pairwise_tournament@1` (M48, ADR-147) is a DISTINCT non-scalar aggregation —
// it consumes per-match A/B/tie verdicts and produces a ranking, never a
// universal score (see lib/evaluations/aggregation/tournament.ts). A method
// declaring it MUST use the `pairwise` mode.
export const AGGREGATION_ALGORITHMS = [
  "weighted_mean@1",
  "median@1",
  "majority@1",
  "pairwise_tournament@1",
] as const;
export type AggregationAlgorithm = (typeof AGGREGATION_ALGORITHMS)[number];

// The scalar (per-criterion combine) subset — `pairwise_tournament@1` is
// excluded because it is a ranking aggregation, not a scalar combine.
export const SCALAR_AGGREGATION_ALGORITHMS = [
  "weighted_mean@1",
  "median@1",
  "majority@1",
] as const;
export type ScalarAggregationAlgorithm =
  (typeof SCALAR_AGGREGATION_ALGORITHMS)[number];

// Closed objective-check provider registry (M46, ADR-143 D11). All are
// non-executable from package content: recorded gate/artifact results,
// schema/contract validation, source/diff manifest statistics, and
// operator-configured trusted host check profiles. Build/test/lint runs only
// through a pre-registered host `trusted_host_check@1` profile whose command
// and sandbox are platform-owned — the method only NAMES the profile.
// ADR-165 adds the recursive-harness measures. They read tree-scoped recorded
// facts (`ObjectiveFactSource.tree`) and, like every provider here, execute
// nothing.
export const OBJECTIVE_CHECK_PROVIDERS = [
  "gate_result@1",
  "artifact_completeness@1",
  "schema_contract@1",
  "diff_stats@1",
  "trusted_host_check@1",
  "child_run_count@1",
  "result_validation_failures@1",
  "collected_results_ratio@1",
  "consumed_results_ratio@1",
  "rework_count@1",
  "crash_count@1",
  "tree_tokens@1",
  "tree_wall_clock_minutes@1",
  "promotion_readiness@1",
] as const;
export type ObjectiveCheckProvider = (typeof OBJECTIVE_CHECK_PROVIDERS)[number];

// Evaluation modes. `absolute` scores each participant independently on the
// rubric; `n_way` scores participants against each other on the same rubric;
// `pairwise` (M48, ADR-147) compares participants two at a time and aggregates
// the match verdicts into a tournament ranking. `n_way` remains the default
// overview — `pairwise` is only intrinsic to methods that declare it.
export const EVALUATION_METHOD_MODES = [
  "absolute",
  "n_way",
  "pairwise",
] as const;
export type EvaluationMethodMode = (typeof EVALUATION_METHOD_MODES)[number];

// How an objective check's result relates to the panel/criteria (ADR-143 D11).
export const OBJECTIVE_CHECK_POLICIES = [
  "gate", // blocks judging when failed
  "metric", // supplies a metric, does not gate
  "cap", // caps/overrides a named criterion
  "unscored", // recorded but not scored
  "partial_ok", // absence permits a Partial evaluation
] as const;
export type ObjectiveCheckPolicy = (typeof OBJECTIVE_CHECK_POLICIES)[number];

// How a missing/NA criterion is represented — never a numeric zero (ADR-145 D12).
export const CRITERION_NA_POLICIES = [
  "insufficient_evidence",
  "not_applicable",
] as const;

const refIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "id must be kebab-case ([a-z0-9-], leading alphanumeric)",
  );

// A package-relative asset path — no absolute paths, no traversal, no leading
// slash. Mirrors packageRelativePathSchema semantics (ADR-088) but local to the
// evaluation domain to keep the method schema self-contained.
const methodAssetPathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.startsWith("~") &&
      !p.split("/").includes("..") &&
      !/^[a-zA-Z]:[\\/]/.test(p),
    "asset path must be package-relative (no absolute path, `~`, `..`, or drive)",
  );

const scaleSchema = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
  })
  .strict()
  .refine((s) => s.max > s.min, "scale.max must be greater than scale.min");

const anchorSchema = z
  .object({
    score: z.number(),
    label: z.string().min(1),
  })
  .strict();

const subcriterionSchema = z
  .object({
    id: refIdSchema,
    name: z.string().min(1),
    weight: z.number().positive(),
  })
  .strict();

const criterionSchema = z
  .object({
    id: refIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    weight: z.number().positive(),
    scale: scaleSchema,
    anchors: z.array(anchorSchema).min(2),
    optional: z.boolean().default(false),
    naPolicy: z.enum(CRITERION_NA_POLICIES).default("insufficient_evidence"),
    itemCap: z.number().optional(),
    subcriteria: z.array(subcriterionSchema).default([]),
  })
  .strict();

const boundedAdjustmentSchema = z
  .object({
    id: refIdSchema,
    name: z.string().min(1),
    max: z.number().positive(),
  })
  .strict();

const objectiveCheckSchema = z
  .object({
    id: refIdSchema,
    provider: z.enum(OBJECTIVE_CHECK_PROVIDERS),
    policy: z.enum(OBJECTIVE_CHECK_POLICIES),
    // For `cap`, the criterion the check caps/overrides.
    criterionId: refIdSchema.optional(),
    // For `trusted_host_check@1`, the operator-registered host profile id. The
    // command/sandbox are platform-owned; the method only names the profile.
    hostCheckProfile: refIdSchema.optional(),
    description: z.string().optional(),
  })
  .strict()
  .superRefine((check, ctx) => {
    if (check.policy === "cap" && !check.criterionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["criterionId"],
        message: "policy `cap` requires `criterionId`",
      });
    }
    if (check.provider === "trusted_host_check@1" && !check.hostCheckProfile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hostCheckProfile"],
        message: "provider `trusted_host_check@1` requires `hostCheckProfile`",
      });
    }
  });

const judgeRoleSchema = z
  .object({
    id: refIdSchema,
    name: z.string().min(1),
    // Independent attempt count requested for this role (ADR-145 D12).
    count: z.number().int().positive(),
    promptTemplate: methodAssetPathSchema,
    description: z.string().optional(),
  })
  .strict();

const disagreementSchema = z
  .object({
    scoreSpreadThreshold: z.number().nonnegative(),
    confidenceSpreadThreshold: z.number().nonnegative().optional(),
    escalateOnConflict: z.boolean().default(false),
  })
  .strict();

const panelPolicySchema = z
  .object({
    quorum: z.number().int().positive(),
    timeoutSeconds: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative().default(0),
    onInvalidOutput: z
      .enum(["exclude", "repair_then_exclude"])
      .default("repair_then_exclude"),
    onMissingJudge: z.enum(["exclude", "block"]).default("exclude"),
    disagreement: disagreementSchema,
  })
  .strict();

const aggregationSchema = z
  .object({
    algorithm: z.enum(AGGREGATION_ALGORITHMS),
    // Bounded, algorithm-specific parameters (validated per algorithm at
    // normalization time). Never executable.
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const groundTruthSchema = z
  .object({
    required: z.boolean().default(false),
    description: z.string().optional(),
  })
  .strict();

const evidenceProtocolSchema = z
  .object({
    captureBudgetBytes: z.number().int().positive(),
    requiredCoverage: z.array(z.string().min(1)).default([]),
    description: z.string().optional(),
  })
  .strict();

const methodCompatSchema = z
  .object({
    engine_min: z.string().optional(),
    engine_max: z.string().optional(),
  })
  .strict();

const capsSchema = z
  .object({
    totalMax: z.number().optional(),
  })
  .strict();

// The full `evaluation-method.yaml` shape (schemaVersion 1). `.strict()` at
// every level so an unknown key is a loud CONFIG failure, never a silent drop.
export const evaluationMethodSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: refIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    modes: z.array(z.enum(EVALUATION_METHOD_MODES)).min(1),
    groundTruth: groundTruthSchema.default({ required: false }),
    evidence: evidenceProtocolSchema,
    objectiveChecks: z.array(objectiveCheckSchema).default([]),
    criteria: z.array(criterionSchema).min(1),
    bonuses: z.array(boundedAdjustmentSchema).default([]),
    penalties: z.array(boundedAdjustmentSchema).default([]),
    caps: capsSchema.default({}),
    judges: z
      .object({
        roles: z.array(judgeRoleSchema).min(1),
        resultSchema: methodAssetPathSchema,
      })
      .strict(),
    aggregation: aggregationSchema,
    panelPolicy: panelPolicySchema,
    report: z
      .object({
        primaryView: z
          .enum(["scoreboard", "heatmap", "pairwise"])
          .default("scoreboard"),
      })
      .strict()
      .default({ primaryView: "scoreboard" }),
    compat: methodCompatSchema.default({}),
  })
  .strict()
  .superRefine((method, ctx) => {
    // M48 coupling: the tournament aggregation and the `pairwise` mode are two
    // sides of the same method shape — one without the other is incoherent.
    const isTournament =
      method.aggregation.algorithm === "pairwise_tournament@1";
    const hasPairwise = method.modes.includes("pairwise");

    if (isTournament && !hasPairwise) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modes"],
        message:
          "aggregation `pairwise_tournament@1` requires the `pairwise` mode",
      });
    }
    if (hasPairwise && !isTournament) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aggregation", "algorithm"],
        message:
          "`pairwise` mode requires the `pairwise_tournament@1` aggregation",
      });
    }
  });

export type EvaluationMethodDefinition = z.infer<typeof evaluationMethodSchema>;
