import "server-only";

import type { Logger } from "pino";
import type { MaisterYamlV2 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches existing usage in
// web/scripts/seed.ts, web/app/api/runs/route.ts, web/lib/flows.ts).
const { executors, flows } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "executors",
  level: process.env.LOG_LEVEL ?? "info",
});

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export type ResolveExecutorTier =
  | "launcher"
  | "task"
  | "flowOverride"
  | "projectDefault"
  | "flowRecommended";

export type ResolveExecutorArgs = {
  override?: string;
  task: { executorOverrideId: string | null };
  flow: {
    executorOverrideId: string | null;
    recommendedExecutorId: string | null;
  };
  project: { defaultExecutorId: string | null };
};

export type ResolveExecutorResult = {
  executorId: string;
  tier: ResolveExecutorTier;
};

/**
 * Pure 5-level executor resolution chain. Highest tier wins:
 *
 *   1. launcher        — explicit override at Launch click (run launcher).
 *   2. task            — `tasks.executorOverrideId` (per-task choice).
 *   3. flowOverride    — `flows.executorOverrideId` (project-side
 *                        `maister.yaml flows[].executor_override`).
 *   4. projectDefault  — `projects.defaultExecutorId`.
 *   5. flowRecommended — `flows.recommendedExecutorId`
 *                        (`flow.yaml recommended_executor`).
 *
 * No DB access, no logging side effects — callers fetch the rows and log
 * the returned tier. Callers passing `override: undefined` get the
 * "computed executor for display" path (used by the future task-card
 * badge to render what executor a task would resolve to without
 * launching).
 *
 * Throws `MaisterError("EXECUTOR_UNAVAILABLE")` when all five tiers are
 * nullish.
 */
export function resolveExecutor(
  args: ResolveExecutorArgs,
): ResolveExecutorResult {
  if (args.override) return { executorId: args.override, tier: "launcher" };
  if (args.task.executorOverrideId)
    return { executorId: args.task.executorOverrideId, tier: "task" };
  if (args.flow.executorOverrideId)
    return { executorId: args.flow.executorOverrideId, tier: "flowOverride" };
  if (args.project.defaultExecutorId)
    return {
      executorId: args.project.defaultExecutorId,
      tier: "projectDefault",
    };
  if (args.flow.recommendedExecutorId)
    return {
      executorId: args.flow.recommendedExecutorId,
      tier: "flowRecommended",
    };

  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "no executor resolved (no launcher override, task override, flow override, project default, or flow recommendation)",
  );
}

export type UpsertExecutorsFromConfigArgs = {
  projectId: string;
  config: MaisterYamlV2;
  // FIXME(any): see schema.integration.test.ts for the drizzle dual-variant
  // issue — caller may pass node-postgres or better-sqlite3 client.
  db?: any;
  logger?: Logger;
};

export type UpsertExecutorsFromConfigResult = {
  executorIdByRef: Record<string, string>;
  defaultExecutorId: string;
};

/**
 * Persist `maister.yaml` executors + per-flow overrides into the DB.
 *
 * - Upserts one row per `config.executors[]` keyed by
 *   `(projectId, executor_ref_id)` UNIQUE, stable PKs across runs.
 * - For EVERY `config.flows[]` entry, writes the matching `flows` row's
 *   `executorOverrideId` column to the resolved override id when
 *   `executor_override` is present, OR to `null` when absent. This is
 *   the SET-and-CLEAR symmetry the consumer (`resolveExecutor`) relies
 *   on: an empty YAML field MUST reset the column so the chain falls
 *   through to the project default. Skipping the CLEAR branch leaves
 *   the previous value persisted — a defect, never "documented
 *   behavior". Flow rows that do not yet exist (e.g. `installFlowPlugin`
 *   has not run) get a WARN and a zero-row update; the caller wires the
 *   override later via the returned ref→PK map.
 *
 * Whole operation is wrapped in a single transaction for atomicity.
 *
 * Returns the ref→PK map and the resolved `defaultExecutorId` PK so the
 * caller can set `projects.defaultExecutorId`.
 */
export async function upsertExecutorsFromConfig(
  args: UpsertExecutorsFromConfigArgs,
): Promise<UpsertExecutorsFromConfigResult> {
  const { projectId, config } = args;

  if (config.executors.length === 0) {
    throw new MaisterError(
      "CONFIG",
      `upsertExecutorsFromConfig: config.executors[] is empty for project ${projectId}`,
    );
  }

  const db = args.db ?? getDb();
  const lg = args.logger ?? log;

  lg.info(
    {
      projectId,
      executorCount: config.executors.length,
      flowOverrideCount: config.flows.filter((f) => f.executor_override).length,
    },
    "upsertExecutorsFromConfig start",
  );

  try {
    return await (db as { transaction: any }).transaction(async (tx: any) => {
      const executorIdByRef: Record<string, string> = {};

      for (const ex of config.executors) {
        const newId = randomUUID();
        const rows = await tx
          .insert(executors)
          .values({
            id: newId,
            projectId,
            executorRefId: ex.id,
            agent: ex.agent,
            model: ex.model,
            env: ex.env ?? null,
            router: ex.router ?? null,
          })
          .onConflictDoUpdate({
            target: [executors.projectId, executors.executorRefId],
            set: {
              agent: ex.agent,
              model: ex.model,
              env: ex.env ?? null,
              router: ex.router ?? null,
            },
          })
          .returning({ id: executors.id });

        const rowId = rows[0]?.id;

        if (!rowId) {
          throw new Error(`executor upsert for ${ex.id} returned no row`);
        }

        executorIdByRef[ex.id] = rowId;
        lg.debug(
          {
            projectId,
            executorRefId: ex.id,
            agent: ex.agent,
            model: ex.model,
            hasEnv: Boolean(ex.env && Object.keys(ex.env).length > 0),
            router: ex.router ?? null,
          },
          "executor upserted",
        );
      }

      const defaultExecutorId = executorIdByRef[config.default_executor];

      if (!defaultExecutorId) {
        throw new MaisterError(
          "CONFIG",
          `default_executor "${config.default_executor}" not found in executors[] after upsert`,
        );
      }

      for (const flow of config.flows) {
        let overrideId: string | null = null;

        if (flow.executor_override) {
          const resolved = executorIdByRef[flow.executor_override];

          if (!resolved) {
            throw new MaisterError(
              "CONFIG",
              `flow "${flow.id}" executor_override "${flow.executor_override}" not in executors[]`,
            );
          }
          overrideId = resolved;
        }

        const result = await tx
          .update(flows)
          .set({ executorOverrideId: overrideId })
          .where(
            and(eq(flows.projectId, projectId), eq(flows.flowRefId, flow.id)),
          )
          .returning({ id: flows.id });

        if (result.length === 0) {
          lg.warn(
            { projectId, flowRefId: flow.id, overrideId },
            "flow row not yet installed — executor_override write skipped (will be re-applied next call)",
          );
        } else {
          lg.debug(
            { projectId, flowRefId: flow.id, overrideId },
            overrideId === null
              ? "flow executor_override cleared"
              : "flow executor_override applied",
          );
        }
      }

      lg.info(
        {
          projectId,
          executorCount: Object.keys(executorIdByRef).length,
          defaultExecutorId,
        },
        "upsertExecutorsFromConfig done",
      );

      return { executorIdByRef, defaultExecutorId };
    });
  } catch (err) {
    if (err instanceof MaisterError) throw err;
    throw new MaisterError(
      "CONFIG",
      `upsertExecutorsFromConfig failed: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }
}
