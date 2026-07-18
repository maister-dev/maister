import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type {
  EvaluationPanelPolicy,
  EvaluationPanelRoleBinding,
} from "@/lib/evaluations/types";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { deriveMethodHealth } from "./methods-registry";

import { getDb } from "@/lib/db/client";
import {
  evaluationJudgePanels,
  evaluationMethodRevisions,
  evaluationProfiles,
  evaluationProjectProfileOverrides,
  packageInstalls,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "evaluations-resolution",
  level: process.env.LOG_LEVEL ?? "info",
});

// Hard structural cap (D12): one agent slot always stays free so a full panel
// can never starve every other agent Run. Mirrors MAISTER_MAX_CONCURRENT_AGENTS
// (default 3) − 1; read from env so ops tuning stays in one place.
function maxParallelAttemptsCeiling(): number {
  const raw = Number(process.env.MAISTER_MAX_CONCURRENT_AGENTS ?? "3");
  const cap = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;

  return Math.max(1, cap - 1);
}

// The overridable numeric policy knobs and their (inclusive) bound key. A field
// absent from a Profile's `allowedOverrides` is not overridable at all.
const NUMERIC_POLICY_FIELDS = [
  "attempts",
  "maxParallelAttempts",
  "quorum",
  "timeoutMs",
  "maxRetries",
] as const;

const BOOLEAN_POLICY_FIELDS = ["blindLabels", "randomizeOrder"] as const;

type Bound = { min?: number; max?: number };
type AllowedOverrideEntry = Bound | true;

export type AppliedOverride = {
  source: "project" | "study";
  field: string;
  value: number | boolean;
};

export interface EffectiveProfileSnapshot {
  profileId: string;
  profileRevision: number;
  methodRevisionId: string;
  methodQualifiedId: string;
  methodDigests: {
    definitionDigest: string;
    promptDigest: string;
    schemaDigest: string;
  };
  panelId: string;
  panelRevision: number;
  roleBindings: EvaluationPanelRoleBinding[];
  policy: EvaluationPanelPolicy;
  appliedOverrides: AppliedOverride[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withinBound(value: number, bound: Bound, field: string): void {
  if (bound.min !== undefined && value < bound.min) {
    throw new MaisterError(
      "CONFIG",
      `override "${field}" value ${value} is below the allowed minimum ${bound.min}`,
    );
  }
  if (bound.max !== undefined && value > bound.max) {
    throw new MaisterError(
      "CONFIG",
      `override "${field}" value ${value} exceeds the allowed maximum ${bound.max}`,
    );
  }
}

// Validate + fold one override map (project or study tier) onto the working
// policy. Every key must be in the Profile's `allowedOverrides` allow-list;
// numeric values are bound-checked against BOTH the allow-list entry's bound and
// the Profile hard limit. An unknown/forbidden key is a typed CONFIG refusal —
// never silently dropped.
function applyOverrideTier(
  tier: "project" | "study",
  overrides: Record<string, unknown>,
  allowed: Record<string, AllowedOverrideEntry>,
  hardLimits: Record<string, Bound>,
  policy: Record<string, unknown>,
  applied: AppliedOverride[],
): void {
  for (const [field, rawValue] of Object.entries(overrides)) {
    if (!(field in allowed)) {
      throw new MaisterError(
        "CONFIG",
        `${tier} override "${field}" is not in the profile's allowed overrides`,
      );
    }

    if ((NUMERIC_POLICY_FIELDS as readonly string[]).includes(field)) {
      const value = Number(rawValue);

      if (!Number.isFinite(value)) {
        throw new MaisterError(
          "CONFIG",
          `${tier} override "${field}" must be a finite number`,
        );
      }

      const allowEntry = allowed[field];

      if (allowEntry !== true) withinBound(value, allowEntry, field);
      if (hardLimits[field]) withinBound(value, hardLimits[field], field);

      policy[field] = value;
      applied.push({ source: tier, field, value });
    } else if ((BOOLEAN_POLICY_FIELDS as readonly string[]).includes(field)) {
      if (typeof rawValue !== "boolean") {
        throw new MaisterError(
          "CONFIG",
          `${tier} override "${field}" must be a boolean`,
        );
      }
      policy[field] = rawValue;
      applied.push({ source: tier, field, value: rawValue });
    } else {
      throw new MaisterError(
        "CONFIG",
        `${tier} override "${field}" is not an overridable policy field`,
      );
    }
  }
}

// Validate an override map against a Profile's allow-list + hard limits WITHOUT
// applying it — used at project-override write time so a forbidden/out-of-bound
// value is rejected when saved (D8: "constrained by the Profile allow-list"),
// not only later at resolution. Throws CONFIG on the first violation.
export function assertOverridesAllowed(
  tier: "project" | "study",
  overrides: Record<string, unknown>,
  allowedOverrides: unknown,
  hardLimits: unknown,
): void {
  applyOverrideTier(
    tier,
    overrides,
    asRecord(allowedOverrides) as Record<string, AllowedOverrideEntry>,
    asRecord(hardLimits) as Record<string, Bound>,
    {},
    [],
  );
}

// Enforce the method + platform hard constraints that survive every override
// tier (D8: "method hard constraints → platform Profile hard bounds" win). These
// are structural invariants, not preferences — a violation after overrides is a
// CONFIG refusal, so a bad override can never launch an incoherent panel.
function enforceHardConstraints(
  policy: EvaluationPanelPolicy,
  methodQuorumFloor: number,
): void {
  if (policy.attempts < 1) {
    throw new MaisterError("CONFIG", "resolved attempts must be at least 1");
  }
  if (policy.quorum < 1 || policy.quorum > policy.attempts) {
    throw new MaisterError(
      "CONFIG",
      `resolved quorum ${policy.quorum} must be within [1, attempts=${policy.attempts}]`,
    );
  }
  if (policy.quorum < methodQuorumFloor) {
    throw new MaisterError(
      "CONFIG",
      `resolved quorum ${policy.quorum} is below the method quorum floor ${methodQuorumFloor}`,
    );
  }

  const ceiling = maxParallelAttemptsCeiling();

  if (policy.maxParallelAttempts < 1 || policy.maxParallelAttempts > ceiling) {
    throw new MaisterError(
      "CONFIG",
      `resolved maxParallelAttempts ${policy.maxParallelAttempts} must be within [1, ${ceiling}] (one agent slot stays free)`,
    );
  }
  if (policy.timeoutMs <= 0) {
    throw new MaisterError("CONFIG", "resolved timeoutMs must be positive");
  }
  if (policy.maxRetries < 0) {
    throw new MaisterError(
      "CONFIG",
      "resolved maxRetries must be non-negative",
    );
  }
}

// Resolve the complete effective profile at Evaluation Execution start (D8).
// Precedence (highest wins): method hard constraints → platform Profile hard
// bounds → current Panel binding → saved project override → per-Study allowed
// override. The returned snapshot is immutable evidence — later Panel/Profile
// edits never mutate it. `studyOverrides` are the request-time per-Study values
// (already allow-list-scoped here; the route only forwards them).
export async function resolveEffectiveProfile(
  args: {
    profileId: string;
    projectId: string;
    studyOverrides?: Record<string, unknown>;
  },
  db?: Db,
): Promise<EffectiveProfileSnapshot> {
  const _db = db ?? getDb();

  const profileRows = await _db
    .select()
    .from(evaluationProfiles)
    .where(eq(evaluationProfiles.id, args.profileId));
  const profile = profileRows[0];

  if (!profile) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation profile not found: ${args.profileId}`,
    );
  }
  if (!profile.enabled) {
    throw new MaisterError(
      "CONFIG",
      `evaluation profile ${args.profileId} is disabled`,
    );
  }

  const methodRows = await _db
    .select({
      id: evaluationMethodRevisions.id,
      qualifiedId: evaluationMethodRevisions.qualifiedId,
      activation: evaluationMethodRevisions.activation,
      compat: evaluationMethodRevisions.compat,
      validationErrors: evaluationMethodRevisions.validationErrors,
      definitionDigest: evaluationMethodRevisions.definitionDigest,
      promptDigest: evaluationMethodRevisions.promptDigest,
      schemaDigest: evaluationMethodRevisions.schemaDigest,
      normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
      trustStatus: packageInstalls.trustStatus,
    })
    .from(evaluationMethodRevisions)
    .innerJoin(
      packageInstalls,
      eq(evaluationMethodRevisions.packageInstallId, packageInstalls.id),
    )
    .where(eq(evaluationMethodRevisions.id, profile.methodRevisionId));
  const method = methodRows[0];

  if (!method) {
    throw new MaisterError(
      "PRECONDITION",
      `method revision not found: ${profile.methodRevisionId}`,
    );
  }

  const health = deriveMethodHealth(method, method.trustStatus);

  if (method.activation !== "enabled" || health !== "ready") {
    throw new MaisterError(
      "CONFIG",
      `method ${method.qualifiedId} is not selectable (activation=${method.activation}, health=${health})`,
    );
  }

  const panelRows = await _db
    .select()
    .from(evaluationJudgePanels)
    .where(eq(evaluationJudgePanels.id, profile.panelId));
  const panel = panelRows[0];

  if (!panel) {
    throw new MaisterError(
      "PRECONDITION",
      `judge panel not found: ${profile.panelId}`,
    );
  }
  if (!panel.enabled) {
    throw new MaisterError(
      "CONFIG",
      `judge panel ${profile.panelId} is disabled`,
    );
  }

  const basePolicy = panel.policy as EvaluationPanelPolicy;
  // Work on a mutable copy; the panel binding is the base tier.
  const working: Record<string, unknown> = { ...basePolicy };

  const allowed = asRecord(profile.allowedOverrides) as Record<
    string,
    AllowedOverrideEntry
  >;
  const hardLimits = asRecord(profile.hardLimits) as Record<string, Bound>;
  const applied: AppliedOverride[] = [];

  const projectOverrideRows = await _db
    .select({ overrides: evaluationProjectProfileOverrides.overrides })
    .from(evaluationProjectProfileOverrides)
    .where(
      and(
        eq(evaluationProjectProfileOverrides.projectId, args.projectId),
        eq(evaluationProjectProfileOverrides.profileId, args.profileId),
      ),
    );

  if (projectOverrideRows[0]) {
    applyOverrideTier(
      "project",
      projectOverrideRows[0].overrides,
      allowed,
      hardLimits,
      working,
      applied,
    );
  }

  if (args.studyOverrides) {
    applyOverrideTier(
      "study",
      args.studyOverrides,
      allowed,
      hardLimits,
      working,
      applied,
    );
  }

  const resolvedPolicy = working as unknown as EvaluationPanelPolicy;
  const methodDef = asRecord(method.normalizedDefinition.definition);
  const methodPanelPolicy = asRecord(methodDef.panelPolicy);
  const methodQuorumFloor =
    typeof methodPanelPolicy.quorum === "number" ? methodPanelPolicy.quorum : 1;

  enforceHardConstraints(resolvedPolicy, methodQuorumFloor);

  const snapshot: EffectiveProfileSnapshot = {
    profileId: profile.id,
    profileRevision: profile.revision,
    methodRevisionId: method.id,
    methodQualifiedId: method.qualifiedId,
    methodDigests: {
      definitionDigest: method.definitionDigest,
      promptDigest: method.promptDigest,
      schemaDigest: method.schemaDigest,
    },
    panelId: panel.id,
    panelRevision: panel.revision,
    roleBindings: panel.roleBindings as EvaluationPanelRoleBinding[],
    policy: resolvedPolicy,
    appliedOverrides: applied,
  };

  log.debug(
    {
      profileId: snapshot.profileId,
      methodRevisionId: snapshot.methodRevisionId,
      panelId: snapshot.panelId,
      appliedOverrides: applied.length,
    },
    "effective evaluation profile resolved",
  );

  return snapshot;
}
