import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run, Workspace, Project } from "@/lib/db/schema";
import type { RunResultContract, ResultStatus } from "@/lib/run-results/types";
import type { RunReviewCause } from "@/lib/domain-events/taxonomy";

import { stat } from "node:fs/promises";

import { and, eq, inArray, is, isNull } from "drizzle-orm";
import { NodePgTransaction } from "drizzle-orm/node-postgres";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import {
  checkRepoReadDirt,
  loadAgentWorkspaceContext,
  quarantineAgentInTx,
  restoreAgentMaterialization,
} from "./dirty-watchdog";
import {
  agentReadOnlyWorkdirPath,
  agentWorkdirPath,
  sharedAgentWorktreePath,
} from "./workspace-paths";
import { revokeAgentRunTokensForRun } from "./tokens";

import { getDb } from "@/lib/db/client";
import { hitlRequests, projects, runs, workspaces } from "@/lib/db/schema";
import { releaseRunContextMounts } from "@/lib/context-mounts/terminal";
import {
  cancelActiveAssignmentsForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { decideAgentResult } from "@/lib/run-results/agent-result";
import { engineArtifactManifest } from "@/lib/run-results/artifact-manifest";
import {
  publishRunResult,
  recordInvalidRunResult,
} from "@/lib/run-results/ledger";
import { gcAgeDays, worktreesRoot } from "@/lib/instance-config";
import { removeOwnedPlainAgentDirectory } from "@/lib/gc/plain-agent-directory-gc";
import { removeWorktree } from "@/lib/worktree";
import { promoteNextPending } from "@/lib/scheduler";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-finalization",
  level: process.env.LOG_LEVEL ?? "info",
});

async function pathIsDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

export type AgentTerminalOutcome = "Done" | "Failed" | "Crashed" | "Abandoned";
export type AgentFinalStatus = AgentTerminalOutcome | "Review";

type AgentAssignmentClose =
  | {
      kind: "user";
      actorId: string;
      eventKind?: "cancelled" | "superseded" | "system_closed";
      reason?: string;
    }
  | {
      kind: "system";
      reason: string;
    };

export type AgentFinalizeOptions = {
  db?: Db;
  reason?: string;
  closeOpenHitl?: boolean;
  closeAssignments?: AgentAssignmentClose;
  // ADR-165 (T5.4): the completing turn's agent text, from which the public
  // result sentinel is extracted. Absent on every non-session caller (an
  // explicit stop, a reconcile), which reads as "no result was emitted".
  finalText?: string;
};

const TERMINAL_CAS_SOURCE: Record<AgentTerminalOutcome, Run["status"][]> = {
  Done: ["Running", "NeedsInput"],
  Failed: ["Running", "NeedsInput"],
  // Crashed also admits a checkpointed (NeedsInputIdle) or reviewing agent
  // child: the reconcile sweep crashes an orphan of a dead coordinator in ANY
  // paused/reviewing status (per-status orphan recovery), and it does so via
  // this choke point so token revocation, HITL close and the agent-pool
  // promote still run. Pending is deliberately absent — a never-started orphan
  // is abandoned, not crashed.
  Crashed: ["Running", "NeedsInput", "NeedsInputIdle", "Review"],
  Abandoned: [
    "Pending",
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "Review",
    "Crashed",
  ],
};

const DOMAIN_KIND_BY_OUTCOME: Record<
  AgentTerminalOutcome,
  "run.done" | "run.failed" | "run.crashed" | "run.abandoned"
> = {
  Done: "run.done",
  Failed: "run.failed",
  Crashed: "run.crashed",
  Abandoned: "run.abandoned",
};

const WEBHOOK_TYPE_BY_STATUS: Record<
  AgentFinalStatus,
  "run.review" | "run.done" | "run.failed" | "run.crashed" | "run.abandoned"
> = {
  Review: "run.review",
  Done: "run.done",
  Failed: "run.failed",
  Crashed: "run.crashed",
  Abandoned: "run.abandoned",
};

function finalStatusForCleanAgentExit(hasWorkspace: boolean): AgentFinalStatus {
  return hasWorkspace ? "Review" : "Done";
}

function shouldReleaseAgentMaterialization(
  status: AgentFinalStatus,
  workspace: "none" | "repo_read" | "worktree",
): boolean {
  if (status === "Review") return false;

  // A worktree-backed crash is resumable through the workspace/session
  // recovery flow. The other workspace modes have no recovery workspace and
  // must release before their terminal cleanup can remove their cwd.
  return status !== "Crashed" || workspace !== "worktree";
}

// The terminal choke point for agent runs (ADR-090 sequencing rule): the
// dirty-watchdog (Phase 4) and the token revoke run BEFORE/WITHIN the
// status-flip transaction; nothing writes the run row after the flip.

export type AgentFinalizationApplication =
  | Readonly<{ finalized: false }>
  | Readonly<{ finalized: true; status: AgentFinalStatus; endedAt: Date }>;

export type PreparedAgentFinalization = Readonly<{
  /** DB-only; the caller may commit its command marker in the same transaction. */
  apply: (tx: Db) => Promise<AgentFinalizationApplication>;
  /** Call only after the outer commit, using the pooled preparation connection. */
  afterCommit: (result: AgentFinalizationApplication) => Promise<void>;
}>;

type FinalizationContext = Readonly<{
  run: Pick<
    Run,
    | "id"
    | "runKind"
    | "executionAssignmentId"
    | "workspaceMode"
    | "agentWorkspace"
    | "rootRunId"
    | "resultContract"
    | "agentId"
    | "taskId"
    | "parentRunId"
    | "contextMounts"
  > & { projectId: string };
  workspaceRows: readonly Pick<Workspace, "id" | "worktreePath">[];
  workspaceContext: Awaited<ReturnType<typeof loadAgentWorkspaceContext>>;
  project: Pick<Project, "slug" | "repoPath"> | null;
}>;

async function loadFinalizationContext(
  db: Db,
  runId: string,
): Promise<FinalizationContext | null> {
  const [run] = await db
    .select({
      id: runs.id,
      runKind: runs.runKind,
      executionAssignmentId: runs.executionAssignmentId,
      workspaceMode: runs.workspaceMode,
      agentWorkspace: runs.agentWorkspace,
      rootRunId: runs.rootRunId,
      resultContract: runs.resultContract,
      agentId: runs.agentId,
      projectId: runs.projectId,
      taskId: runs.taskId,
      parentRunId: runs.parentRunId,
      contextMounts: runs.contextMounts,
    })
    .from(runs)
    .where(eq(runs.id, runId));

  if (!run) return null;
  if (!run.projectId)
    throw new MaisterError(
      "PRECONDITION",
      "agent finalization requires its project provenance",
      {
        details: { reason: "agent_finalization_project_missing", runId },
      },
    );
  const workspaceRows = await db
    .select({ id: workspaces.id, worktreePath: workspaces.worktreePath })
    .from(workspaces)
    .where(eq(workspaces.runId, runId))
    .orderBy(workspaces.id);
  const workspaceContext = run.agentId
    ? await loadAgentWorkspaceContext(db, run.agentId, run.projectId)
    : null;
  const [project] = await db
    .select({ slug: projects.slug, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, run.projectId));

  return {
    run: { ...run, projectId: run.projectId },
    workspaceRows,
    workspaceContext,
    project: project ?? null,
  };
}

/** Prepare external reads before entering the atomic terminal application. */
export async function prepareAgentRunFinalization(
  runId: string,
  outcome: AgentTerminalOutcome,
  opts: AgentFinalizeOptions = {},
): Promise<PreparedAgentFinalization> {
  const _db = opts.db ?? getDb();

  if (is(_db, NodePgTransaction))
    throw new MaisterError(
      "PRECONDITION",
      "prepare agent finalization on a pooled connection before opening its application transaction",
      { details: { reason: "agent_finalization_requires_pooled_db", runId } },
    );
  const original = await loadFinalizationContext(_db, runId);

  if (!original)
    return {
      apply: async () => ({ finalized: false }),
      afterCommit: async () => {},
    };
  const provenance = canonicalCommandJson(original);
  const preparedRun = original.run;
  const workspaceRows = original.workspaceRows;
  let ephemeralCleanup: { repoPath: string; worktreePath: string } | null =
    null;
  let materializationCleanup: {
    cwd: string;
    workspace: "none" | "repo_read" | "worktree";
  } | null = null;
  let quarantine: Omit<Parameters<typeof quarantineAgentInTx>[0], "tx"> | null =
    null;
  // M37 (ADR-102): a shared writable-worktree child finalizes to Review even
  // when it owns no `workspaces` row (a reuser child — the allocator owns the
  // UNIQUE worktree_path). The shared tree is one branch = one diff, reviewed and
  // promoted once; a shared writable child is NEVER auto-Done on a clean exit.
  const isSharedWritableExit =
    preparedRun.workspaceMode === "shared" &&
    preparedRun.agentWorkspace === "worktree";

  const status =
    outcome === "Done"
      ? isSharedWritableExit
        ? "Review"
        : finalStatusForCleanAgentExit(workspaceRows.length > 0)
      : outcome;

  if (outcome === "Done") {
    log.debug(
      {
        runId,
        workspaceMode: preparedRun.workspaceMode,
        agentWorkspace: preparedRun.agentWorkspace,
        hasWorkspace: workspaceRows.length > 0,
        status,
      },
      "agent clean-exit final status",
    );
  }

  // ADR-165 (T5.4 / D10): the public-result decision, taken BEFORE the CAS so
  // a result failure can turn a clean exit into `Failed`. `Failed` / `Crashed`
  // / `Abandoned` outcomes never publish — the run did not finish, so whatever
  // text it produced is not an answer.
  const resultContract = preparedRun.resultContract;
  const resultDecision =
    outcome === "Done" && resultContract
      ? decideAgentResult({
          contract: resultContract,
          finalText: opts.finalText,
        })
      : { kind: "none" as const };
  const effectiveStatus = resultDecision.kind === "invalid" ? "Failed" : status;

  // Cleanup cwd derives from immutable run/workspace/project provenance, not
  // the mutable catalog agent row. Agent deletion is ON DELETE SET NULL and
  // runner-backed consensus drafts intentionally have no agent id; both still
  // own L2/package materialization that must release after the terminal flip.
  const wsCtx = original.workspaceContext;
  const project = original.project;
  // Persisted agent_workspace is authoritative. The live agent definition is
  // only a compatibility fallback for historical rows that predate the run
  // snapshot and still have an agent row.
  const ranAs = original.run.agentWorkspace ?? wsCtx?.workspace;

  if (project && ranAs === "repo_read") {
    // workspace_ref runs leave a deterministic `-ro` checkout: when it
    // exists, the L3 target IS that ephemeral dir (the parent checkout was
    // never the session cwd).
    const ephemeralPath = agentReadOnlyWorkdirPath(project.slug, runId);
    const usedEphemeral = await pathIsDirectory(ephemeralPath);
    const l3Target = usedEphemeral ? ephemeralPath : project.repoPath;

    if (shouldReleaseAgentMaterialization(effectiveStatus, ranAs)) {
      materializationCleanup = { cwd: l3Target, workspace: ranAs };
    }

    // ADR-090 L3 is agent-specific: only a live catalog agent can be
    // quarantined. Inspect before applying the terminal transaction; the
    // quarantine write itself remains part of that transaction.
    if (wsCtx && original.run.agentId) {
      const verdict = await checkRepoReadDirt(l3Target, runId);

      if (verdict.kind !== "clean") {
        const violation =
          verdict.kind === "dirty"
            ? verdict.porcelain.slice(0, 512)
            : `watchdog indeterminate: ${verdict.error.slice(0, 512)}`;

        quarantine = {
          agentId: original.run.agentId,
          runId,
          projectId: original.run.projectId,
          taskId: original.run.taskId,
          reason: `repo_read workspace contract failed for ${l3Target}: ${violation}`,
        };
      }
    }

    if (usedEphemeral) {
      ephemeralCleanup = {
        repoPath: project.repoPath,
        worktreePath: ephemeralPath,
      };
    }
  } else if (project && ranAs === "none") {
    if (shouldReleaseAgentMaterialization(status, ranAs)) {
      materializationCleanup = {
        cwd: agentWorkdirPath(project.slug, runId),
        workspace: ranAs,
      };
    }
  } else if (project && ranAs === "worktree") {
    const worktreePath =
      workspaceRows[0]?.worktreePath ??
      (preparedRun.workspaceMode === "shared" && preparedRun.rootRunId
        ? sharedAgentWorktreePath(project.slug, preparedRun.rootRunId)
        : agentWorkdirPath(project.slug, runId));

    if (shouldReleaseAgentMaterialization(status, ranAs)) {
      materializationCleanup = { cwd: worktreePath, workspace: ranAs };
    }
  }

  const apply = async (tx: Db): Promise<AgentFinalizationApplication> => {
    const [locked] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");

    if (!locked) return { finalized: false };
    const current = await loadFinalizationContext(tx, runId);

    if (canonicalCommandJson(current) !== provenance)
      throw new MaisterError(
        "CONFLICT",
        "agent finalization provenance changed after preparation",
        {
          details: { reason: "agent_finalization_provenance_changed", runId },
        },
      );
    const pendingHumanAskRows = await tx
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, runId),
          eq(hitlRequests.kind, "agent_question"),
          eq(hitlRequests.activationState, "pending_termination"),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.supersededAt),
        ),
      )
      .limit(1);

    if (pendingHumanAskRows[0]) {
      log.info(
        {
          runId,
          outcome,
          hitlRequestId: pendingHumanAskRows[0].id,
        },
        "agent finalization deferred to pending human-ask activation",
      );

      return { finalized: false };
    }

    const endedAt = new Date();

    // M42 (ADR-114): the agent run's session resume handle lives on its
    // `run_sessions` row (sole source of truth) — a delegated child reaching
    // Review keeps it for run_rework session/resume; a terminal run is never
    // resumed (status-gated), so no run-level marker reset is needed here.
    const rows = await tx
      .update(runs)
      .set({
        status: effectiveStatus,
        endedAt,
        currentStepId: null,
      })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.runKind, "agent"),
          inArray(runs.status, TERMINAL_CAS_SOURCE[outcome]),
        ),
      )
      .returning({
        projectId: runs.projectId,
        taskId: runs.taskId,
        agentId: runs.agentId,
        agentWorkspace: runs.agentWorkspace,
        parentRunId: runs.parentRunId,
      });

    if (!rows[0]) return { finalized: false };
    const row = original.run;

    // ADR-166 D7: the terminal status ends the run's driver generation (a
    // Review child re-enters through a NEW generation on rework/re-message).
    await releaseAssignmentForRun(tx, runId, "run_terminal");

    // ADR-165 (D9/W3): the result row commits in THIS transaction — the same one
    // that flips the status and emits the wake — so a woken parent's
    // `run_collect` can never observe a settle without its result.
    let resultStatus: ResultStatus | null = null;

    if (resultDecision.kind === "valid") {
      await publishRunResult(tx, {
        runId,
        value: resultDecision.value,
        valueBytes: resultDecision.valueBytes,
        contract: resultContract as RunResultContract,
        producerKind: "agent_session",
        producerRef: "session:default",
        artifactManifest: await engineArtifactManifest(tx, runId),
      });
      resultStatus = "valid";
    } else if (resultDecision.kind === "invalid") {
      await recordInvalidRunResult(tx, {
        runId,
        contract: resultContract as RunResultContract,
        reason: resultDecision.reason,
        producerKind: "agent_session",
        producerRef: "session:default",
      });
      resultStatus = "unavailable";
      log.warn(
        {
          runId,
          outcome,
          resultStatus,
          reasonClass: resultDecision.reason,
        },
        "[run-result.agent] public result rejected — finalizing Failed",
      );
    } else if (resultDecision.kind === "absent") {
      resultStatus = "absent";
    }

    if (effectiveStatus === "Abandoned") {
      const scheduledRemovalAt = new Date(
        endedAt.getTime() + gcAgeDays() * 86_400_000,
      );

      await tx
        .update(workspaces)
        .set({ scheduledRemovalAt })
        .where(eq(workspaces.runId, runId));
    }

    if (quarantine) await quarantineAgentInTx({ ...quarantine, tx });

    await revokeAgentRunTokensForRun(runId, tx);

    if (opts.closeOpenHitl) {
      await tx
        .update(hitlRequests)
        .set({ respondedAt: endedAt })
        .where(
          and(eq(hitlRequests.runId, runId), isNull(hitlRequests.respondedAt)),
        );
    }

    if (opts.closeAssignments?.kind === "user") {
      await cancelActiveAssignmentsForRun({
        db: tx,
        runId,
        actorId: opts.closeAssignments.actorId,
        eventKind: opts.closeAssignments.eventKind,
        reason: opts.closeAssignments.reason,
      });
    } else if (opts.closeAssignments?.kind === "system") {
      await systemCloseActiveAssignmentsForRun({
        db: tx,
        runId,
        reason: opts.closeAssignments.reason,
      });
    }

    await emitWebhookEvent({
      db: tx,
      type: WEBHOOK_TYPE_BY_STATUS[effectiveStatus],
      projectId: row.projectId,
      runId,
      data: {
        kind: "agent",
        agentId: row.agentId,
        ...(effectiveStatus === "Review" ? { source: "agent" } : {}),
        ...(opts.reason && effectiveStatus !== "Review"
          ? { reason: opts.reason }
          : {}),
      },
    });

    // M37 (ADR-098/097): a DELEGATED child reaching Review emits `run.review` so
    // the parked coordinator wakes to promote/rework the diff (and as-plan
    // auto-promote fires). A top-level Review (no parent) emits nothing — there is
    // no orchestrator to route to. Terminal outcomes emit their terminal kind.
    if (effectiveStatus === "Review") {
      if (row.parentRunId) {
        await emitDomainEvent({
          db: tx,
          kind: "run.review",
          projectId: row.projectId,
          taskId: row.taskId,
          runId,
          actor: { type: "agent", id: row.agentId },
          parentRunId: row.parentRunId,
          payload: {
            runKind: "agent",
            agentId: row.agentId,
            status: effectiveStatus,
            // Codex review F1: the same cause field the flow emit helper
            // writes — a clean agent exit IS a completion and stays
            // auto-promotable.
            cause: "agent_exit" satisfies RunReviewCause,
            // ADR-165 (Q10-A): additive, omitted when the run carries no
            // contract — an omitted value is honestly absent.
            ...(resultStatus ? { resultStatus } : {}),
          },
        });
      }
    } else {
      await emitDomainEvent({
        db: tx,
        // ADR-165: a result-caused failure emits `run.failed`, not the clean
        // exit's `run.done` — the outcome the coordinator must react to is the
        // FAILURE, and a `run.done` here would wake it into believing the child
        // succeeded.
        kind:
          resultDecision.kind === "invalid"
            ? "run.failed"
            : DOMAIN_KIND_BY_OUTCOME[outcome],
        projectId: row.projectId,
        taskId: row.taskId,
        runId,
        actor: { type: "agent", id: row.agentId },
        parentRunId: row.parentRunId,
        payload: {
          runKind: "agent",
          agentId: row.agentId,
          status: effectiveStatus,
          ...(opts.reason ? { reason: opts.reason } : {}),
          ...(resultDecision.kind === "invalid"
            ? {
                reason:
                  resultDecision.reason === "result_missing"
                    ? "result_missing"
                    : "result_invalid",
              }
            : {}),
          ...(resultStatus ? { resultStatus } : {}),
        },
      });
    }

    return { finalized: true, status: effectiveStatus, endedAt };
  };

  const afterCommit = async (
    result: AgentFinalizationApplication,
  ): Promise<void> => {
    if (!result.finalized) return;
    const [committed] = await _db
      .select({
        status: runs.status,
        endedAt: runs.endedAt,
        assignmentId: runs.executionAssignmentId,
      })
      .from(runs)
      .where(eq(runs.id, runId));

    if (
      committed?.status !== result.status ||
      committed.endedAt?.getTime() !== result.endedAt.getTime() ||
      committed.assignmentId !== original.run.executionAssignmentId
    )
      throw new MaisterError(
        "PRECONDITION",
        "agent cleanup requires its committed terminal generation",
        {
          details: { reason: "agent_finalization_commit_unconfirmed", runId },
        },
      );

    let materializationReleaseFailedFor: string | null = null;

    if (materializationCleanup) {
      const cleanup = materializationCleanup as {
        cwd: string;
        workspace: "none" | "repo_read" | "worktree";
      };

      await restoreAgentMaterialization(cleanup.cwd, runId).catch(
        (err: unknown) => {
          materializationReleaseFailedFor = cleanup.cwd;
          log.error(
            {
              runId,
              workspace: cleanup.workspace,
              errorType: err instanceof Error ? err.name : "unknown",
            },
            "post-commit agent materialization release failed",
          );
        },
      );
    }

    log.info(
      {
        runId,
        outcome,
        status: result.status,
        hasReason: Boolean(opts.reason),
      },
      "agent run finalized",
    );

    if (ephemeralCleanup) {
      const cleanup = ephemeralCleanup as {
        repoPath: string;
        worktreePath: string;
      };

      if (materializationReleaseFailedFor === cleanup.worktreePath) {
        log.warn(
          { runId, workspace: "repo_read" },
          "ephemeral checkout retained because materialization release must be retried",
        );
      } else {
        await removeWorktree({
          projectRepoPath: cleanup.repoPath,
          worktreePath: cleanup.worktreePath,
          force: true,
        }).catch((err: unknown) => {
          log.warn(
            {
              runId,
              errorType: err instanceof Error ? err.name : "unknown",
            },
            "ephemeral checkout removal failed — next spawn recreates it",
          );
        });
      }
    }

    const plainAgentCleanup = materializationCleanup as {
      cwd: string;
      workspace: "none" | "repo_read" | "worktree";
    } | null;

    if (
      plainAgentCleanup?.workspace === "none" &&
      materializationReleaseFailedFor !== plainAgentCleanup.cwd
    ) {
      await removeOwnedPlainAgentDirectory({
        root: worktreesRoot(),
        directoryPath: plainAgentCleanup.cwd,
      }).catch((err: unknown) => {
        log.warn(
          {
            runId,
            errorType: err instanceof Error ? err.name : "unknown",
          },
          "plain agent directory removal failed and will retry during GC",
        );
      });
    }

    // ADR-157 (T32): release this run's read-only sibling mounts from the SAME
    // post-commit choke that releases the ephemeral `-ro` checkout. Reads the
    // launch snapshot off `runs.context_mounts` and is status-gated inside, so a
    // clean-exit `Review` (shared writable tree) keeps its mounts for the rework.
    await releaseRunContextMounts({ runId, db: _db }).catch((err: unknown) => {
      log.warn(
        { runId, errorType: err instanceof Error ? err.name : "unknown" },
        "context mount release failed — left to the GC backstop",
      );
    });

    await promoteNextPending({ db: _db, pool: "agent" }).catch(
      (err: unknown) => {
        log.error(
          { runId, errorType: err instanceof Error ? err.name : "unknown" },
          "agent slot promote failed",
        );
      },
    );
  };

  return { apply, afterCommit };
}

/** Terminal entrypoint for callers that own the complete transaction. */
export async function finalizeAgentRun(
  runId: string,
  outcome: AgentTerminalOutcome,
  opts: AgentFinalizeOptions = {},
): Promise<{ finalized: boolean; status?: AgentFinalStatus }> {
  const db = opts.db ?? getDb();
  const prepared = await prepareAgentRunFinalization(runId, outcome, {
    ...opts,
    db,
  });
  const result = await db.transaction(prepared.apply);

  await prepared.afterCommit(result);

  return result.finalized
    ? { finalized: true, status: result.status }
    : { finalized: false };
}
