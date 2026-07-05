import "server-only";

import type {
  BrainProposalAutonomyDecision,
  BrainProposalBlastRadius,
  BrainProposalKind,
} from "@/lib/brain/schema";
import type { BrainHomeResolution } from "@/lib/brain/home-resolution";
import type { BrainIndexingProfile } from "@/lib/brain/indexing-profiles";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { normalizeBrainIndexingProfile } from "@/lib/brain/indexing-profiles";
import { MaisterError } from "@/lib/errors";

const PROPOSAL_KINDS = [
  "rule",
  "skill",
  "flow",
  "adr",
  "roadmap",
  "state",
] as const satisfies readonly BrainProposalKind[];
const BLAST_RADII = [
  "low",
  "medium",
  "high",
] as const satisfies readonly BrainProposalBlastRadius[];
const AUTONOMY_DECISIONS = [
  "manual",
  "auto_draft",
] as const satisfies readonly BrainProposalAutonomyDecision[];

const log = pino({
  name: "brain:autonomy",
  level: process.env.LOG_LEVEL ?? "info",
});

type AutonomyDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type BrainAutonomyPolicyKey =
  `${BrainProposalKind}.${BrainProposalBlastRadius}`;
export type BrainAutonomyPolicy = Partial<
  Record<BrainAutonomyPolicyKey, BrainProposalAutonomyDecision>
>;

export interface BrainAutonomyConfigPatch {
  projectionFlowId?: string | null;
  autonomyDefaults?: unknown;
}

export interface BrainProjectConfig {
  homeResolution: BrainHomeResolution;
  projectionFlowId: string | null;
  autonomyDefaults: BrainAutonomyPolicy;
  indexingProfile: BrainIndexingProfile;
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

function policyKey(
  kind: BrainProposalKind,
  blastRadius: BrainProposalBlastRadius,
): BrainAutonomyPolicyKey {
  return `${kind}.${blastRadius}`;
}

function parsePolicyKey(key: string): {
  kind: BrainProposalKind;
  blastRadius: BrainProposalBlastRadius;
} {
  const [kind, blastRadius, extra] = key.split(".");

  if (
    extra !== undefined ||
    !isOneOf(kind, PROPOSAL_KINDS) ||
    !isOneOf(blastRadius, BLAST_RADII)
  ) {
    throw new MaisterError(
      "CONFIG",
      `invalid Brain autonomy policy key: ${key}`,
    );
  }

  return { kind, blastRadius };
}

export function normalizeBrainAutonomyPolicy(
  input: unknown,
): BrainAutonomyPolicy {
  if (input === undefined || input === null) return {};

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new MaisterError("CONFIG", "Brain autonomy policy must be an object");
  }

  const policy: BrainAutonomyPolicy = {};

  for (const [key, value] of Object.entries(input)) {
    const { kind, blastRadius } = parsePolicyKey(key);

    if (!isOneOf(value, AUTONOMY_DECISIONS)) {
      throw new MaisterError(
        "CONFIG",
        `invalid Brain autonomy decision for ${key}: ${String(value)}`,
      );
    }

    policy[policyKey(kind, blastRadius)] = value;
  }

  return policy;
}

export function resolveBrainAutonomyDecision(
  policy: BrainAutonomyPolicy,
  kind: BrainProposalKind,
  blastRadius: BrainProposalBlastRadius,
): BrainProposalAutonomyDecision {
  return policy[policyKey(kind, blastRadius)] ?? "manual";
}

export async function getBrainAutonomyPolicy(
  db: AutonomyDb,
  projectId: string,
): Promise<BrainAutonomyPolicy> {
  const rows = await db.execute(sql`
    SELECT autonomy_policy
    FROM brain_project_config
    WHERE project_id = ${projectId}
    LIMIT 1
  `);

  return normalizeBrainAutonomyPolicy(rows.rows[0]?.autonomy_policy ?? {});
}

function normalizeBrainHomeResolution(input: unknown): BrainHomeResolution {
  if (input === undefined || input === null) return {};

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new MaisterError("CONFIG", "Brain home resolution must be an object");
  }

  const resolution: BrainHomeResolution = {};

  for (const [kind, value] of Object.entries(input)) {
    if (kind !== "decision" && kind !== "direction") {
      throw new MaisterError("CONFIG", `unknown Brain home kind: ${kind}`);
    }

    if (value !== "owned" && value !== "indexed") {
      throw new MaisterError(
        "CONFIG",
        `invalid Brain home resolution for ${kind}: ${String(value)}`,
      );
    }

    resolution[kind] = value;
  }

  return resolution;
}

export async function getBrainProjectConfig(
  db: AutonomyDb,
  projectId: string,
): Promise<BrainProjectConfig> {
  const rows = await db.execute(sql`
    SELECT home_resolution, projection_flow_id, autonomy_policy,
           indexing_profile
    FROM brain_project_config
    WHERE project_id = ${projectId}
    LIMIT 1
  `);
  const row = rows.rows[0];

  if (!row) {
    return {
      homeResolution: {},
      projectionFlowId: null,
      autonomyDefaults: {},
      indexingProfile: "docs",
    };
  }

  return {
    homeResolution: normalizeBrainHomeResolution(row.home_resolution),
    projectionFlowId: (row.projection_flow_id as string | null) ?? null,
    autonomyDefaults: normalizeBrainAutonomyPolicy(row.autonomy_policy ?? {}),
    indexingProfile: normalizeBrainIndexingProfile(
      row.indexing_profile ?? "docs",
    ),
  };
}

export async function saveBrainAutonomyConfig(
  db: AutonomyDb,
  projectId: string,
  patch: BrainAutonomyConfigPatch,
): Promise<{
  projectionFlowId: string | null | undefined;
  autonomyDefaults: BrainAutonomyPolicy | undefined;
}> {
  const hasProjectionFlowId = "projectionFlowId" in patch;
  const hasAutonomyDefaults = "autonomyDefaults" in patch;
  const autonomyDefaults = hasAutonomyDefaults
    ? normalizeBrainAutonomyPolicy(patch.autonomyDefaults)
    : undefined;
  const projectionFlowId = hasProjectionFlowId
    ? (patch.projectionFlowId ?? null)
    : undefined;

  if (!hasProjectionFlowId && !hasAutonomyDefaults) {
    return { projectionFlowId: undefined, autonomyDefaults: undefined };
  }

  await db.execute(sql`
    INSERT INTO brain_project_config (
      project_id,
      home_resolution,
      projection_flow_id,
      autonomy_policy
    )
    VALUES (
      ${projectId},
      '{}'::jsonb,
      ${projectionFlowId ?? null},
      ${JSON.stringify(autonomyDefaults ?? {})}::jsonb
    )
    ON CONFLICT (project_id)
    DO UPDATE SET
      projection_flow_id = CASE
        WHEN ${hasProjectionFlowId} THEN EXCLUDED.projection_flow_id
        ELSE brain_project_config.projection_flow_id
      END,
      autonomy_policy = CASE
        WHEN ${hasAutonomyDefaults} THEN EXCLUDED.autonomy_policy
        ELSE brain_project_config.autonomy_policy
      END,
      updated_at = now()
  `);

  log.info(
    {
      projectId,
      projectionFlowChanged: hasProjectionFlowId,
      autonomyPolicyChanged: hasAutonomyDefaults,
    },
    "brain autonomy config saved",
  );

  return { projectionFlowId, autonomyDefaults };
}
