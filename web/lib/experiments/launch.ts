import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import pino from "pino";

import type { ProjectAction } from "@/lib/authz";
import type { CapabilityAgent } from "@/lib/config.schema";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  launchExperimentInputSchema,
  type LaunchExperimentInput,
} from "@/lib/experiments/http-schemas";
import type { ExperimentStatus, ExperimentVariant } from "@/lib/experiments/types";
import {
  assertOverlayRefsKnown,
  assertVariantOverlaySupported,
  type OverlayRefCatalog,
} from "@/lib/experiments/variant-config";
import { launchRun } from "@/lib/services/runs";
import { assertBaseCommitReachable } from "@/lib/worktree";

const { capabilityRecords, experimentRuns, experiments, platformAcpRunners, projects } =
  schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "experiments-launch",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ExperimentLaunchOutcome = {
  variantKey: string;
  replicateOrdinal: number;
  runId: string;
  status: "Running" | "Pending";
  queuePosition?: number;
};

export type ExperimentLaunchResponse = {
  experimentId: string;
  outcomes: ExperimentLaunchOutcome[];
};

export type LaunchExperimentVariantsArgs = {
  projectId: string;
  experimentId: string;
  actorUserId: string;
  input: LaunchExperimentInput;
  authorizeRunAction?: (projectId: string, action?: ProjectAction) => Promise<void>;
};

const LAUNCHABLE_EXPERIMENT_STATUSES = new Set<ExperimentStatus>([
  "draft",
  "running",
  "comparable",
]);

function parseLaunchInput(input: LaunchExperimentInput): LaunchExperimentInput {
  const parsed = launchExperimentInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `invalid experiment launch input: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

async function loadProject(projectId: string, db: Db): Promise<Record<string, any>> {
  const rows = await db.select().from(projects).where(eq(projects.id, projectId));
  const project = rows.find(
    (row: Record<string, any>) => row.id === projectId && !row.archivedAt,
  );

  if (!project) {
    throw new MaisterError("PRECONDITION", `project not found: ${projectId}`);
  }

  return project;
}

async function loadExperiment(
  args: { projectId: string; experimentId: string },
  db: Db,
): Promise<Record<string, any>> {
  const rows = await db
    .select()
    .from(experiments)
    .where(eq(experiments.id, args.experimentId))
    .limit(1);
  const experiment = rows.find(
    (row: Record<string, any>) =>
      row.id === args.experimentId && row.projectId === args.projectId,
  );

  if (!experiment) {
    throw new MaisterError(
      "PRECONDITION",
      `experiment not found: ${args.experimentId}`,
    );
  }

  return experiment;
}

async function loadMembershipRows(
  experimentId: string,
  db: Db,
): Promise<Array<Record<string, any>>> {
  const rows = await db
    .select()
    .from(experimentRuns)
    .where(eq(experimentRuns.experimentId, experimentId))
    .orderBy(desc(experimentRuns.replicateOrdinal));

  return rows.filter(
    (row: Record<string, any>) => row.experimentId === experimentId,
  );
}

function selectedVariants(
  variants: ExperimentVariant[],
  requested: LaunchExperimentInput["variants"],
): ExperimentVariant[] {
  if (requested === "all") return variants;

  const byKey = new Map(variants.map((variant) => [variant.key, variant]));

  return requested.map((key) => {
    const variant = byKey.get(key);

    if (!variant) {
      throw new MaisterError("CONFIG", `unknown experiment variant: ${key}`);
    }

    return variant;
  });
}

function nextOrdinalByVariant(
  variants: ExperimentVariant[],
  existingRows: Array<Record<string, any>>,
): Map<string, number> {
  const next = new Map(variants.map((variant) => [variant.key, 1]));

  for (const row of existingRows) {
    const current = next.get(row.variantKey);
    const observed = Number(row.replicateOrdinal);

    if (current === undefined || !Number.isFinite(observed)) continue;
    if (observed >= current) next.set(row.variantKey, observed + 1);
  }

  return next;
}

function hasOverlay(variant: ExperimentVariant): boolean {
  const overlay = variant.config.capabilityOverlay;

  if (!overlay) return false;

  return Object.values(overlay).some(
    (delta) => (delta?.add?.length ?? 0) > 0 || (delta?.remove?.length ?? 0) > 0,
  );
}

async function loadOverlayRefCatalog(
  projectId: string,
  db: Db,
): Promise<OverlayRefCatalog> {
  const rows = await db
    .select({
      capabilityRefId: capabilityRecords.capabilityRefId,
      kind: capabilityRecords.kind,
    })
    .from(capabilityRecords)
    .where(
      and(
        eq(capabilityRecords.projectId, projectId),
        isNull(capabilityRecords.disabledAt),
      ),
    );
  const refs: OverlayRefCatalog = {
    rules: new Set(),
    skills: new Set(),
    mcps: new Set(),
    subagents: new Set(),
  };

  for (const row of rows as Array<Record<string, unknown>>) {
    const ref = String(row.capabilityRefId);

    if (row.kind === "rule") refs.rules.add(ref);
    if (row.kind === "skill") refs.skills.add(ref);
    if (row.kind === "mcp") refs.mcps.add(ref);
    if (row.kind === "agent_definition") refs.subagents.add(ref);
  }

  return refs;
}

async function loadRunnerAgents(
  runnerIds: string[],
  db: Db,
): Promise<Map<string, CapabilityAgent>> {
  if (runnerIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: platformAcpRunners.id,
      capabilityAgent: platformAcpRunners.capabilityAgent,
    })
    .from(platformAcpRunners);

  return new Map(
    (rows as Array<Record<string, unknown>>)
      .filter((row) => runnerIds.includes(String(row.id)))
      .map((row) => [
        String(row.id),
        row.capabilityAgent as CapabilityAgent,
      ]),
  );
}

async function validateVariantOverlayBatch(args: {
  projectId: string;
  variants: ExperimentVariant[];
  db: Db;
}): Promise<void> {
  const overlayVariants = args.variants.filter(hasOverlay);

  if (overlayVariants.length === 0) return;

  const [refs, runnerAgents] = await Promise.all([
    loadOverlayRefCatalog(args.projectId, args.db),
    loadRunnerAgents(
      overlayVariants
        .map((variant) => variant.config.runnerId)
        .filter((runnerId): runnerId is string => runnerId !== undefined),
      args.db,
    ),
  ]);

  for (const variant of overlayVariants) {
    assertOverlayRefsKnown(variant.config.capabilityOverlay, refs);

    if (!variant.config.runnerId) continue;

    const capabilityAgent = runnerAgents.get(variant.config.runnerId);

    if (!capabilityAgent) {
      throw new MaisterError(
        "CONFIG",
        `variant "${variant.key}" runner "${variant.config.runnerId}" is not available for overlay validation`,
      );
    }

    assertVariantOverlaySupported({
      capabilityAgent,
      variantKey: variant.key,
      overlay: variant.config.capabilityOverlay,
    });
  }
}

export async function launchExperimentVariants(
  args: LaunchExperimentVariantsArgs,
  db?: Db,
): Promise<ExperimentLaunchResponse> {
  const input = parseLaunchInput(args.input);
  const _db = db ?? getDb();
  const [project, experiment] = await Promise.all([
    loadProject(args.projectId, _db),
    loadExperiment(
      { projectId: args.projectId, experimentId: args.experimentId },
      _db,
    ),
  ]);
  const status = experiment.status as ExperimentStatus;

  if (!LAUNCHABLE_EXPERIMENT_STATUSES.has(status)) {
    throw new MaisterError(
      "PRECONDITION",
      `experiment ${args.experimentId} is not launchable from ${status}`,
    );
  }

  const variants = selectedVariants(
    experiment.variants as ExperimentVariant[],
    input.variants,
  );
  await validateVariantOverlayBatch({
    projectId: args.projectId,
    variants,
    db: _db,
  });
  const existingRows = await loadMembershipRows(args.experimentId, _db);
  const nextOrdinal = nextOrdinalByVariant(variants, existingRows);

  try {
    await assertBaseCommitReachable({
      projectRepoPath: project.repoPath,
      baseRef: experiment.baseBranch,
      baseCommit: experiment.baseCommit,
    });
  } catch (err) {
    throw new MaisterError(
      "PRECONDITION",
      isMaisterError(err)
        ? err.message
        : `experiment base commit is not launchable: ${String(err)}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  const batch = variants.flatMap((variant) =>
    Array.from({ length: input.replicates }, (_, idx) => ({
      variant,
      replicateOrdinal: (nextOrdinal.get(variant.key) ?? 1) + idx,
    })),
  );

  log.info(
    {
      projectId: args.projectId,
      experimentId: args.experimentId,
      taskId: experiment.taskId,
      baseBranch: experiment.baseBranch,
      baseCommit: experiment.baseCommit,
      variantCount: variants.length,
      replicateCount: input.replicates,
      launchCount: batch.length,
    },
    "experiment launch batch validated",
  );

  const outcomes: ExperimentLaunchOutcome[] = [];

  for (const item of batch) {
    const result = await launchRun(
      {
        taskId: experiment.taskId,
        runnerId: item.variant.config.runnerId,
        executionPolicy: item.variant.config.executionPolicy,
        baseBranch: experiment.baseBranch,
        baseCommit: experiment.baseCommit,
        experimentMembership: {
          experimentId: args.experimentId,
          variantKey: item.variant.key,
          replicateOrdinal: item.replicateOrdinal,
          launchReason: "initial",
          baseCommit: experiment.baseCommit,
          markExperimentRunning: outcomes.length === 0 && status === "draft",
        },
      },
      {
        actorUserId: args.actorUserId,
        authorize:
          args.authorizeRunAction ??
          (async () => {
            return undefined;
          }),
      },
      _db,
    );
    const outcome: ExperimentLaunchOutcome = {
      variantKey: item.variant.key,
      replicateOrdinal: item.replicateOrdinal,
      runId: result.runId,
      status: result.status === "Running" ? "Running" : "Pending",
      ...(result.queuePosition !== undefined
        ? { queuePosition: result.queuePosition }
        : {}),
    };

    outcomes.push(outcome);
    log.info(
      {
        projectId: args.projectId,
        experimentId: args.experimentId,
        variantKey: item.variant.key,
        replicateOrdinal: item.replicateOrdinal,
        runId: result.runId,
        baseCommit: experiment.baseCommit,
        queueState: outcome.status,
        queuePosition: outcome.queuePosition,
      },
      "experiment member run launched",
    );
  }

  return { experimentId: args.experimentId, outcomes };
}
