import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { selectForUpdate } from "@/lib/db/select-for-update";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { ExperimentNotFoundError } from "@/lib/experiments/errors";
import {
  experimentToDetailDTO,
  experimentToListItemDTO,
  type ExperimentDetailDTO,
  type ExperimentListItemDTO,
  type ExperimentRow,
} from "@/lib/experiments/dto";
import {
  abandonExperimentInputSchema,
  concludeExperimentInputSchema,
  createExperimentInputSchema,
  type AbandonExperimentInput,
  type ConcludeExperimentInput,
  type CreateExperimentInput,
} from "@/lib/experiments/http-schemas";
import type {
  ExperimentHumanVerdict,
  ExperimentMemberRunStatus,
  ExperimentRubric,
  ExperimentVariant,
} from "@/lib/experiments/types";
import {
  DEFAULT_EXPERIMENT_RUBRIC,
  validateExperimentHumanVerdict,
} from "@/lib/experiments/rubric";
import { isSettledRunStatus } from "@/lib/runs/run-status-sets";
import { actorForUserId, recordTaskActivity } from "@/lib/social/activity";
import { stopWorkbenchRun } from "@/lib/workbench-lifecycle/service";
import { assertBaseCommitReachable, resolveBaseCommit } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { experimentRuns, experiments, flows, projects, runs, tasks } =
  schemaModule as unknown as Record<string, any>;

type Db = any;
type StopMemberRun = (runId: string) => Promise<unknown>;

const log = pino({
  name: "experiments-service",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CreateExperimentArgs = {
  projectId: string;
  slug: string;
  actorUserId: string;
  input: CreateExperimentInput;
};

export type ExperimentFlowOption = {
  id: string;
  ref: string;
};

function parseCreateInput(input: CreateExperimentInput): CreateExperimentInput {
  const parsed = createExperimentInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `invalid experiment input: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

function assertUniqueVariantKeys(variants: ExperimentVariant[]): void {
  const seen = new Set<string>();

  for (const variant of variants) {
    if (!seen.has(variant.key)) {
      seen.add(variant.key);
      continue;
    }

    throw new MaisterError(
      "CONFIG",
      `duplicate experiment variant key: ${variant.key}`,
    );
  }
}

function byCreatedAtDesc(
  left: Record<string, any>,
  right: Record<string, any>,
): number {
  return (
    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  );
}

async function loadProject(
  projectId: string,
  db: Db,
): Promise<Record<string, any>> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));
  const project = rows.find(
    (row: Record<string, any>) => row.id === projectId && !row.archivedAt,
  );

  if (!project) {
    throw new MaisterError("PRECONDITION", `project not found: ${projectId}`);
  }

  if (typeof project.repoPath !== "string" || project.repoPath.length === 0) {
    throw new MaisterError(
      "CONFIG",
      `project ${projectId} has no repository path`,
    );
  }

  return project;
}

async function loadTask(
  taskId: string,
  db: Db,
): Promise<Record<string, any> | null> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, taskId));

  return rows.find((row: Record<string, any>) => row.id === taskId) ?? null;
}

async function loadStoppableMemberRunIds(
  tx: Db,
  args: {
    experimentId: string;
    excludeVariantKey?: string;
  },
): Promise<string[]> {
  const memberRows = (await tx
    .select()
    .from(experimentRuns)
    .where(eq(experimentRuns.experimentId, args.experimentId))) as Array<
    Record<string, any>
  >;
  const candidateRunIds = new Set<string>();

  for (const memberRow of memberRows) {
    if (
      args.excludeVariantKey &&
      memberRow.variantKey === args.excludeVariantKey
    ) {
      continue;
    }
    if (typeof memberRow.runId === "string")
      candidateRunIds.add(memberRow.runId);
  }

  if (candidateRunIds.size === 0) return [];

  const runRows = (await tx
    .select()
    .from(runs)
    .where(inArray(runs.id, [...candidateRunIds]))) as Array<
    Record<string, any>
  >;

  return runRows
    .filter((runRow) => candidateRunIds.has(String(runRow.id)))
    .filter((runRow) => {
      const status = String(runRow.status) as ExperimentMemberRunStatus;

      return !isSettledRunStatus(status);
    })
    .map((runRow) => String(runRow.id));
}

async function stopMemberRunsAfterCommit(args: {
  experimentId: string;
  runIds: string[];
  stopRun?: StopMemberRun;
  reason: "abandon" | "abandon_losers";
}): Promise<void> {
  if (args.runIds.length === 0) return;

  const stopRun = args.stopRun ?? stopWorkbenchRun;
  const failedRunIds: string[] = [];

  for (const runId of args.runIds) {
    try {
      await stopRun(runId);
      log.info(
        {
          experimentId: args.experimentId,
          runId,
          stopReason: args.reason,
        },
        "experiment member run stopped",
      );
    } catch (err) {
      log.error(
        {
          experimentId: args.experimentId,
          runId,
          stopReason: args.reason,
          error: err instanceof Error ? err.message : String(err),
        },
        "experiment member run stop failed",
      );
      failedRunIds.push(runId);
    }
  }

  if (failedRunIds.length > 0) {
    log.warn(
      {
        experimentId: args.experimentId,
        stopReason: args.reason,
        failedRunIds,
      },
      "experiment member run stop failures ignored after terminal commit",
    );
  }
}

async function resolveCreateBaseCommit(args: {
  projectRepoPath: string;
  baseBranch: string;
  baseRef?: string;
}): Promise<string> {
  try {
    if (args.baseRef === undefined) {
      return await resolveBaseCommit({
        projectRepoPath: args.projectRepoPath,
        baseRef: args.baseBranch,
      });
    }

    const explicitCommit = await resolveBaseCommit({
      projectRepoPath: args.projectRepoPath,
      baseRef: args.baseRef,
    });

    return await assertBaseCommitReachable({
      projectRepoPath: args.projectRepoPath,
      baseRef: args.baseBranch,
      baseCommit: explicitCommit,
    });
  } catch (err) {
    const message = isMaisterError(err) ? err.message : String(err);

    throw new MaisterError(
      "CONFIG",
      `invalid experiment base ref: ${message}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

export async function createExperiment(
  args: CreateExperimentArgs,
  db?: Db,
): Promise<ExperimentDetailDTO> {
  const input = parseCreateInput(args.input);
  const _db = db ?? getDb();

  assertUniqueVariantKeys(input.variants);

  const [project, task] = await Promise.all([
    loadProject(args.projectId, _db),
    loadTask(input.taskId, _db),
  ]);

  if (!task || task.projectId !== args.projectId) {
    log.warn(
      {
        slug: args.slug,
        projectId: args.projectId,
        taskId: input.taskId,
        actorId: args.actorUserId,
      },
      "experiment create rejected for task outside project",
    );

    throw new MaisterError(
      "PRECONDITION",
      `task not found for project: ${input.taskId}`,
    );
  }

  const baseCommit = await resolveCreateBaseCommit({
    projectRepoPath: project.repoPath,
    baseBranch: input.baseBranch,
    baseRef: input.baseRef,
  });
  const now = new Date();
  const row = {
    id: randomUUID(),
    projectId: args.projectId,
    taskId: input.taskId,
    title: input.title,
    description: input.description ?? null,
    baseBranch: input.baseBranch,
    baseCommit,
    status: "draft" as const,
    variants: input.variants,
    rubric: input.rubric ?? DEFAULT_EXPERIMENT_RUBRIC,
    verdict: null,
    createdByUserId: args.actorUserId,
    createdAt: now,
    updatedAt: now,
    launchedAt: null,
    comparableAt: null,
    concludedAt: null,
    abandonedAt: null,
  };
  const inserted = await _db.insert(experiments).values(row).returning();
  const created = inserted[0] ?? row;

  log.info(
    {
      slug: args.slug,
      projectId: args.projectId,
      experimentId: created.id,
      taskId: input.taskId,
      actorId: args.actorUserId,
      baseBranch: input.baseBranch,
      baseCommit,
      variantsCount: input.variants.length,
    },
    "experiment created",
  );

  return experimentToDetailDTO(created);
}

export async function listProjectExperiments(
  projectId: string,
  db?: Db,
): Promise<ExperimentListItemDTO[]> {
  const _db = db ?? getDb();
  const [experimentRows, taskRows] = await Promise.all([
    _db
      .select()
      .from(experiments)
      .where(eq(experiments.projectId, projectId))
      .orderBy(desc(experiments.createdAt)),
    _db.select().from(tasks).where(eq(tasks.projectId, projectId)),
  ]);
  const taskNumberById = new Map<string, number>();

  for (const task of taskRows as Array<Record<string, any>>) {
    if (task.projectId !== projectId) continue;
    taskNumberById.set(task.id, task.number);
  }

  return (experimentRows as Array<Record<string, any>>)
    .filter((row) => row.projectId === projectId)
    .sort(byCreatedAtDesc)
    .map((row) =>
      experimentToListItemDTO(
        row as ExperimentRow,
        taskNumberById.get(row.taskId) ?? 0,
      ),
    );
}

export async function listProjectExperimentFlows(
  projectId: string,
  db?: Db,
): Promise<ExperimentFlowOption[]> {
  const _db = (db ?? getDb()) as unknown as {
    select: any;
  };
  const rows = await _db
    .select({ id: flows.id, ref: flows.flowRefId })
    .from(flows)
    .where(eq(flows.projectId, projectId))
    .orderBy(flows.flowRefId);

  log.debug(
    { projectId, flowCount: rows.length },
    "[FIX:experiment-create-flow] loaded experiment flow options",
  );

  return (rows as Array<{ id: string; ref: string }>).map((row) => ({
    id: row.id,
    ref: row.ref,
  }));
}

export async function getExperimentDetail(
  projectId: string,
  experimentId: string,
  db?: Db,
): Promise<ExperimentDetailDTO | null> {
  const _db = db ?? getDb();
  const rows = await _db
    .select()
    .from(experiments)
    .where(
      and(
        eq(experiments.id, experimentId),
        eq(experiments.projectId, projectId),
      ),
    )
    .limit(1);
  const row = (rows as Array<Record<string, any>>).find(
    (candidate) =>
      candidate.id === experimentId && candidate.projectId === projectId,
  );

  return row ? experimentToDetailDTO(row as ExperimentRow) : null;
}

export async function concludeExperiment(
  args: {
    projectId: string;
    experimentId: string;
    actor: { type: "user"; id: string } | { type: "agent"; id: string };
    input: ConcludeExperimentInput;
    stopRun?: StopMemberRun;
  },
  db?: Db,
): Promise<ExperimentDetailDTO> {
  if (args.actor.type !== "user") {
    throw new MaisterError(
      "UNAUTHORIZED",
      "only a human session can conclude an experiment",
    );
  }

  const parsed = concludeExperimentInputSchema.safeParse(args.input);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `invalid experiment conclusion: ${parsed.error.message}`,
    );
  }

  const _db = db ?? getDb();

  const result = await _db.transaction(async (tx: Db) => {
    const lockedRows = await selectForUpdate(
      tx
        .select()
        .from(experiments)
        .where(
          and(
            eq(experiments.id, args.experimentId),
            eq(experiments.projectId, args.projectId),
          ),
        ),
    );
    const experiment = lockedRows.find(
      (row) => row.id === args.experimentId && row.projectId === args.projectId,
    );

    if (!experiment) {
      throw new ExperimentNotFoundError(args.experimentId);
    }
    if (experiment.status !== "comparable") {
      throw new MaisterError(
        "PRECONDITION",
        `experiment ${args.experimentId} is not comparable`,
      );
    }

    const human = validateExperimentHumanVerdict({
      variants: experiment.variants as ExperimentVariant[],
      rubric: experiment.rubric as ExperimentRubric,
      verdict: parsed.data as ExperimentHumanVerdict,
    });
    const stopRunIds =
      parsed.data.abandonLosers && human.winnerVariantKey
        ? await loadStoppableMemberRunIds(tx, {
            experimentId: args.experimentId,
            excludeVariantKey: human.winnerVariantKey,
          })
        : [];
    const now = new Date();
    const currentVerdict =
      (experiment.verdict as Record<string, unknown> | null) ?? {};
    const verdict = { ...currentVerdict, human };
    const updatedRows = await tx
      .update(experiments)
      .set({
        status: "concluded",
        verdict,
        concludedByUserId: args.actor.id,
        concludedAt: now,
        updatedAt: now,
      })
      .where(eq(experiments.id, args.experimentId))
      .returning();
    const updated = updatedRows[0] ?? {
      ...experiment,
      status: "concluded",
      verdict,
      concludedByUserId: args.actor.id,
      concludedAt: now,
      updatedAt: now,
    };

    await recordTaskActivity(tx, {
      taskId: String(experiment.taskId),
      projectId: args.projectId,
      actor: actorForUserId(args.actor.id),
      eventKind: "experiment_concluded",
      payload: {
        experimentId: args.experimentId,
        outcome: human.outcome,
        winnerVariantKey: human.winnerVariantKey ?? null,
      },
    });

    log.info(
      {
        projectId: args.projectId,
        experimentId: args.experimentId,
        actorId: args.actor.id,
        winnerVariantKey: human.winnerVariantKey ?? null,
        affectedRunIds: stopRunIds,
        status: "concluded",
      },
      "experiment concluded",
    );

    return {
      dto: experimentToDetailDTO(updated as ExperimentRow),
      stopRunIds,
    };
  });

  await stopMemberRunsAfterCommit({
    experimentId: args.experimentId,
    runIds: result.stopRunIds,
    stopRun: args.stopRun,
    reason: "abandon_losers",
  });

  return result.dto;
}

export async function abandonExperiment(
  args: {
    projectId: string;
    experimentId: string;
    actorUserId: string;
    input: AbandonExperimentInput;
    stopRun?: StopMemberRun;
  },
  db?: Db,
): Promise<ExperimentDetailDTO> {
  const parsed = abandonExperimentInputSchema.safeParse(args.input);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `invalid experiment abandon input: ${parsed.error.message}`,
    );
  }

  const _db = db ?? getDb();

  const result = await _db.transaction(async (tx: Db) => {
    const lockedRows = await selectForUpdate(
      tx
        .select()
        .from(experiments)
        .where(
          and(
            eq(experiments.id, args.experimentId),
            eq(experiments.projectId, args.projectId),
          ),
        ),
    );
    const experiment = lockedRows.find(
      (row) => row.id === args.experimentId && row.projectId === args.projectId,
    );

    if (!experiment) {
      throw new ExperimentNotFoundError(args.experimentId);
    }
    if (
      experiment.status === "concluded" ||
      experiment.status === "abandoned"
    ) {
      throw new MaisterError(
        "PRECONDITION",
        `experiment ${args.experimentId} is already terminal`,
      );
    }

    const now = new Date();
    const stopRunIds = parsed.data.stopLiveRuns
      ? await loadStoppableMemberRunIds(tx, {
          experimentId: args.experimentId,
        })
      : [];
    const updatedRows = await tx
      .update(experiments)
      .set({
        status: "abandoned",
        abandonedAt: now,
        updatedAt: now,
      })
      .where(eq(experiments.id, args.experimentId))
      .returning();
    const updated = updatedRows[0] ?? {
      ...experiment,
      status: "abandoned",
      abandonedAt: now,
      updatedAt: now,
    };

    log.info(
      {
        projectId: args.projectId,
        experimentId: args.experimentId,
        actorId: args.actorUserId,
        stopLiveRuns: parsed.data.stopLiveRuns,
        affectedRunIds: stopRunIds,
      },
      "experiment abandoned",
    );

    return {
      dto: experimentToDetailDTO(updated as ExperimentRow),
      stopRunIds,
    };
  });

  await stopMemberRunsAfterCommit({
    experimentId: args.experimentId,
    runIds: result.stopRunIds,
    stopRun: args.stopRun,
    reason: "abandon",
  });

  return result.dto;
}
