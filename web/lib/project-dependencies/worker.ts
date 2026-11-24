import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { DurableWorkerHandle } from "@/lib/workers/health";

import { setTimeout as delay } from "node:timers/promises";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import {
  claimDependency,
  liveDependencyClaim,
  nextDependencyLease,
  requireCurrentDependency,
  dependencyLeaseMs,
} from "./claims";
import { executeTrustedSetup } from "./post-trust";
import { executeDependency } from "./executor";
import { withDependencySetupContext } from "./setup";

import { projectDependencyAttempts as attempts } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { runWorkerLoop } from "@/lib/workers/loop";

const log = pino({ name: "project-dependency-worker" });

const retryBudget = 3;

type Attempt = typeof attempts.$inferSelect;

type DependencyStage =
  "resolve" | "install" | "attach" | "projection" | "setup";

export async function serviceDependency(
  db: Db,
  signal: AbortSignal,
  attemptId?: string,
): Promise<boolean> {
  const claim = await claimDependency(db, attemptId);

  if (!claim) return false;
  const logger = log.child({
    projectId: claim.projectId,
    declarationId: claim.declarationId,
    generation: claim.generation,
    attempt: claim.attemptNo,
  });

  logger.info(
    { stage: claim.stage ?? "resolve" },
    "dependency attempt claimed",
  );
  const cancellation = new AbortController();
  const combined = AbortSignal.any([signal, cancellation.signal]);
  let stage: DependencyStage = "resolve";
  const progress = async (
    next: DependencyStage,
    update: Partial<Pick<Attempt, "resolvedRevision" | "memberRef">> & {
      checkpoint?: Attempt["checkpoint"] | SQL;
    } = {},
  ) => {
    stage = next;
    logger.info({ stage }, "dependency attempt advanced");
    const [owned] = await db
      .update(attempts)
      .set({
        ...update,
        stage,
        updatedAt: new Date(),
        leaseExpiresAt: nextDependencyLease,
      })
      .where(liveDependencyClaim(claim))
      .returning({ id: attempts.id });

    if (!owned)
      throw new MaisterError("CONFLICT", "Dependency attempt was superseded", {
        details: { reason: "superseded" },
      });
  };
  const renewal = setInterval(() => {
    void db
      .update(attempts)
      .set({ leaseExpiresAt: nextDependencyLease })
      .where(liveDependencyClaim(claim))
      .returning({ id: attempts.id })
      .then((rows) => {
        if (!rows.length) cancellation.abort();
      })
      .catch(() => cancellation.abort());
  }, dependencyLeaseMs / 3);

  try {
    const { project, declaration } = await db.transaction((tx) =>
      requireCurrentDependency(tx, claim),
    );

    await withDependencySetupContext(
      {
        db,
        recoveryOf: claim.retryOfAttemptId,
        before: async (materialKey, memberRef) => {
          await progress("setup", {
            memberRef,
            checkpoint: sql`coalesce(${attempts.checkpoint}, '{}'::jsonb) || jsonb_build_object('setupMaterialKey', ${materialKey}::text)`,
          });
        },
      },
      () =>
        claim.checkpoint.postTrust
          ? executeTrustedSetup(db, claim, claim.checkpoint.postTrust, combined)
          : executeDependency({
              db,
              claim,
              project,
              declaration,
              signal: combined,
              authorizePublication: async (tx) => {
                await requireCurrentDependency(tx, claim);
              },
              progress,
            }),
    );
    const [completed] = await db
      .update(attempts)
      .set({
        status: "succeeded",
        reason: null,
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(liveDependencyClaim(claim))
      .returning({ id: attempts.id });

    if (completed) logger.info({ stage }, "dependency attempt succeeded");
  } catch (error) {
    const raw = isMaisterError(error) ? error.details?.reason : undefined;
    const reason =
      typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw)
        ? raw
        : isMaisterError(error)
          ? error.code === "CONFIG"
            ? "invalid_manifest"
            : error.code.toLowerCase()
          : "installation_failed";
    const diagnosticMember = isMaisterError(error)
      ? (error.details?.memberRef ?? error.details?.flowRef)
      : null;
    const memberRef =
      typeof diagnosticMember === "string" &&
      /^[a-zA-Z0-9:_-]{1,200}$/.test(diagnosticMember)
        ? diagnosticMember
        : undefined;
    const retryCount = Number(claim.checkpoint?.retryCount ?? 0);
    const transient =
      reason === "executor_unavailable" ||
      reason === "source_unavailable" ||
      reason === "setup_owner_live";
    const requeue =
      combined.aborted ||
      reason === "project_archived" ||
      reason === "earlier_member_pending" ||
      (transient && retryCount < retryBudget);
    const uncertain =
      reason === "setup_uncertain" ||
      (reason === "setup_owner_live" && retryCount >= retryBudget);

    await db
      .update(attempts)
      .set({
        status: uncertain
          ? "recovery_required"
          : requeue
            ? "pending"
            : "failed",
        stage: reason.startsWith("setup_") ? "setup" : stage,
        reason,
        memberRef,
        leaseExpiresAt: null,
        claimToken: null,
        updatedAt: new Date(),
        dueAt: new Date(
          Date.now() + (requeue ? 1000 * 2 ** Math.min(retryCount, 6) : 0),
        ),
        checkpoint: sql`coalesce(${attempts.checkpoint}, '{}'::jsonb) || jsonb_build_object('retryCount', ${retryCount + Number(transient && !combined.aborted)}::int)`,
      })
      .where(liveDependencyClaim(claim));
    logger.warn(
      {
        stage,
        reason,
        requeue,
      },
      "dependency realization interrupted",
    );
  } finally {
    clearInterval(renewal);
  }

  return true;
}

export function startProjectDependencyWorker({
  db,
}: {
  db: Db;
}): DurableWorkerHandle {
  const controller = new AbortController();
  const failures = new Map<number, string>();
  const slots = [0, 1].map((slot) =>
    runWorkerLoop(controller.signal, async () => {
      try {
        const progressed = await serviceDependency(db, controller.signal);

        failures.delete(slot);
        if (progressed) return;
      } catch (error) {
        failures.set(
          slot,
          isMaisterError(error) ? error.code : "worker_unavailable",
        );
        log.error({ reason: failures.get(slot) }, "dependency worker degraded");
      }
      await delay(1000, undefined, { signal: controller.signal }).catch(
        (error) => {
          if (!controller.signal.aborted) throw error;
        },
      );
    }),
  );

  return {
    health: () => ({
      state: controller.signal.aborted
        ? "stopped"
        : failures.size
          ? "degraded"
          : "running",
      reason: failures.values().next().value ?? null,
    }),
    stop: async () => {
      controller.abort();
      await Promise.all(slots);
    },
  };
}
