import "server-only";

import type { EphemeralAgentGcSummary } from "@/lib/gc/ephemeral-agent-gc";
import type { ContextMountGcSummary } from "@/lib/gc/context-mount-gc";
import type { AgentMaterializationGcSummary } from "@/lib/gc/agent-materialization-gc";
import type { RevisionGcSummary } from "@/lib/gc/revision-gc";
import type { WorkspaceGcSummary } from "@/lib/gc/workspace-gc";
import type { PlainAgentDirectoryGcSummary } from "@/lib/gc/plain-agent-directory-gc";
import type { EvidenceSweepSummary } from "@/lib/evaluations/evidence/gc";
import type { WorkspaceReconciliationSummary } from "@/lib/gc/workspace-reconciler";

import pino from "pino";

import { runBrainDecaySweep } from "@/lib/brain/decay";
import { runBrainReindexSweep } from "@/lib/brain/reindex";
import { runCapabilitiesCleanupSweep } from "@/lib/capabilities/cleanup";
import { executionCommandReconcilePass } from "@/lib/execution-host";
import { runEphemeralAgentGcSweep } from "@/lib/gc/ephemeral-agent-gc";
import { runContextMountGcSweep } from "@/lib/gc/context-mount-gc";
import { runAgentMaterializationCleanupSweep } from "@/lib/gc/agent-materialization-gc";
import { runRevisionGcSweep } from "@/lib/gc/revision-gc";
import { runWorkspaceGcSweep } from "@/lib/gc/workspace-gc";
import { sweepEvaluationEvidence } from "@/lib/evaluations/evidence/gc";
import { runPlainAgentDirectoryGcSweep } from "@/lib/gc/plain-agent-directory-gc";
import { runWorkspaceReconciliationSweep } from "@/lib/gc/workspace-reconciler";
import { runReconcileSweep } from "@/lib/reconcile";
import { reconcileTerminalCostRollups } from "@/lib/runs/cost-reconcile-sweep";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { runSyncRecoverySweep } from "@/lib/runs/sync-recovery";

export type GcCompatibilitySummary = {
  worktreesPreserved: number;
  worktreesRemoved: number;
  revisionsRemoved: number;
  errors: string[];
};

export type SystemSweepSummary = GcCompatibilitySummary & {
  // Service-level failures mean the scheduler bundle did not complete and must
  // consume the scheduler attempt's retry budget. Candidate failures remain in
  // `errors` only because their own durable rows carry retry/quarantine state.
  bundleErrors: string[];
  keepalive: Awaited<ReturnType<typeof runSweepTick>> | null;
  reconcile: Awaited<ReturnType<typeof runReconcileSweep>> | null;
  // ADR-141: branch-sync recovery sweep — W1/W4 orphan-operation
  // recovery + the W5 active-time duration cap. null when it threw before
  // returning a summary.
  syncRecovery: Awaited<ReturnType<typeof runSyncRecoverySweep>> | null;
  cost: Awaited<ReturnType<typeof reconcileTerminalCostRollups>> | null;
  // ADR-165 D5/D8: execution-command crash-window recovery (W1/W2/W4 with the
  // 60 s in-flight grace), the stale-active-assignment backstop, and the 7-day
  // terminal-row retention. null when it threw before returning a summary.
  executionHost: Awaited<
    ReturnType<typeof executionCommandReconcilePass>
  > | null;
  workspace: WorkspaceGcSummary | null;
  workspaceReconciliation: WorkspaceReconciliationSummary | null;
  revision: RevisionGcSummary | null;
  capabilities: Awaited<ReturnType<typeof runCapabilitiesCleanupSweep>> | null;
  ephemeralAgent: EphemeralAgentGcSummary | null;
  // ADR-157 (T32): the read-only sibling-repo context-mount backstop — reaps
  // mounts whose owning run is terminal/absent (including the residual crash
  // window where the launch snapshot was never committed).
  contextMount: ContextMountGcSummary | null;
  agentMaterialization: AgentMaterializationGcSummary | null;
  // T2.3 (ADR-142): the Evaluation evidence sweep — recovers crashed captures
  // (orphan `preparing`) and finalizes unreferenced two-stage deletes.
  evaluationEvidence: EvidenceSweepSummary | null;
  plainAgentDirectory: PlainAgentDirectoryGcSummary | null;
  // ADR-122: the Project Brain decay sweep (self-throttled hourly; expires items
  // past expires_at). null when it never ran this process.
  brain: Awaited<ReturnType<typeof runBrainDecaySweep>> | null;
  // ADR-122: the Project Brain reindex worker (drains brain_index_jobs after a
  // model/dimension switch — re-embeds active items into the new generation).
  // null when it threw before returning a summary.
  brainReindex: Awaited<ReturnType<typeof runBrainReindexSweep>> | null;
};

const log = pino({
  name: "scheduler-system-sweeps",
  level: process.env.LOG_LEVEL ?? "info",
});

type GcBundleResult = {
  workspace: WorkspaceGcSummary | null;
  workspaceReconciliation: WorkspaceReconciliationSummary | null;
  revision: RevisionGcSummary | null;
  capabilities: SystemSweepSummary["capabilities"];
  ephemeralAgent: EphemeralAgentGcSummary | null;
  contextMount: ContextMountGcSummary | null;
  agentMaterialization: AgentMaterializationGcSummary | null;
  evaluationEvidence: EvidenceSweepSummary | null;
  plainAgentDirectory: PlainAgentDirectoryGcSummary | null;
  errors: string[];
  bundleErrors: string[];
};

async function runGcBundle(): Promise<GcBundleResult> {
  const errors: string[] = [];
  const bundleErrors: string[] = [];
  let workspace: WorkspaceGcSummary | null = null;
  let workspaceReconciliation: WorkspaceReconciliationSummary | null = null;
  let revision: RevisionGcSummary | null = null;
  let capabilities: SystemSweepSummary["capabilities"] = null;
  let ephemeralAgent: EphemeralAgentGcSummary | null = null;
  let contextMount: ContextMountGcSummary | null = null;
  let agentMaterialization: AgentMaterializationGcSummary | null = null;
  let evaluationEvidence: EvidenceSweepSummary | null = null;
  let plainAgentDirectory: PlainAgentDirectoryGcSummary | null = null;

  try {
    workspace = await runWorkspaceGcSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`workspace sweep failed: ${message}`);
    bundleErrors.push(`workspace sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle workspace threw");
  }

  try {
    workspaceReconciliation = await runWorkspaceReconciliationSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`workspace reconciliation sweep failed: ${message}`);
    bundleErrors.push(`workspace reconciliation sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle workspace reconciliation threw");
  }

  try {
    revision = await runRevisionGcSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`revision sweep failed: ${message}`);
    bundleErrors.push(`revision sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle revision threw");
  }

  try {
    capabilities = await runCapabilitiesCleanupSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`capabilities sweep failed: ${message}`);
    bundleErrors.push(`capabilities sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle capabilities threw");
  }

  try {
    ephemeralAgent = await runEphemeralAgentGcSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`ephemeral agent sweep failed: ${message}`);
    bundleErrors.push(`ephemeral agent sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle ephemeral agent threw");
  }

  try {
    contextMount = await runContextMountGcSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`context mount sweep failed: ${message}`);
    bundleErrors.push(`context mount sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle context mount threw");
  }

  try {
    agentMaterialization = await runAgentMaterializationCleanupSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`agent materialization sweep failed: ${message}`);
    bundleErrors.push(`agent materialization sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle agent materialization threw");
  }

  try {
    evaluationEvidence = await sweepEvaluationEvidence();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`evaluation evidence sweep failed: ${message}`);
    bundleErrors.push(`evaluation evidence sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle evaluation evidence threw");
  }

  try {
    plainAgentDirectory = await runPlainAgentDirectoryGcSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`plain agent directory sweep failed: ${message}`);
    bundleErrors.push(`plain agent directory sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle plain agent directory threw");
  }

  errors.push(...gcFailureMessages(workspace, revision, capabilities));
  if (workspaceReconciliation && workspaceReconciliation.retryableFailed > 0) {
    errors.push(
      `${workspaceReconciliation.retryableFailed} workspace reconciliation candidate(s) failed (left for retry)`,
    );
  }
  if (workspaceReconciliation && workspaceReconciliation.quarantined > 0) {
    errors.push(
      `${workspaceReconciliation.quarantined} workspace reconciliation candidate(s) quarantined for operator review`,
    );
  }
  if (ephemeralAgent && ephemeralAgent.failed > 0) {
    errors.push(
      `${ephemeralAgent.failed} ephemeral -ro checkout(s) failed to remove (left for retry)`,
    );
  }
  if (contextMount && contextMount.failed > 0) {
    errors.push(
      `${contextMount.failed} context mount(s) failed to remove (bounded retry armed)`,
    );
  }
  if (contextMount && contextMount.poisoned > 0) {
    errors.push(
      `${contextMount.poisoned} context mount(s) permanently failed for operator review`,
    );
  }
  if (agentMaterialization && agentMaterialization.failed > 0) {
    errors.push(
      `${agentMaterialization.failed} agent materialization cleanup(s) failed (left for retry)`,
    );
  }
  if (plainAgentDirectory && plainAgentDirectory.failed > 0) {
    errors.push(
      `${plainAgentDirectory.failed} plain agent directory cleanup(s) failed (left for retry)`,
    );
  }

  return {
    workspace,
    workspaceReconciliation,
    revision,
    capabilities,
    ephemeralAgent,
    contextMount,
    agentMaterialization,
    evaluationEvidence,
    plainAgentDirectory,
    errors,
    bundleErrors,
  };
}

export async function runSystemSweep(): Promise<SystemSweepSummary> {
  const errors: string[] = [];
  const bundleErrors: string[] = [];
  let keepalive: SystemSweepSummary["keepalive"] = null;
  let reconcile: SystemSweepSummary["reconcile"] = null;
  let syncRecovery: SystemSweepSummary["syncRecovery"] = null;
  let cost: SystemSweepSummary["cost"] = null;

  try {
    keepalive = await runSweepTick();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`keepalive sweep failed: ${message}`);
    bundleErrors.push(`keepalive sweep failed: ${message}`);
    log.error({ err: message }, "system_sweep keepalive threw");
  }

  try {
    reconcile = await runReconcileSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`reconcile sweep failed: ${message}`);
    bundleErrors.push(`reconcile sweep failed: ${message}`);
    log.error({ err: message }, "system_sweep reconcile threw");
  }

  try {
    syncRecovery = await runSyncRecoverySweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`sync recovery sweep failed: ${message}`);
    bundleErrors.push(`sync recovery sweep failed: ${message}`);
    log.error({ err: message }, "system_sweep sync recovery threw");
  }

  try {
    cost = await reconcileTerminalCostRollups();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`cost reconcile sweep failed: ${message}`);
    bundleErrors.push(`cost reconcile sweep failed: ${message}`);
    log.error({ err: message }, "system_sweep cost reconcile threw");
  }

  let executionHost: SystemSweepSummary["executionHost"] = null;

  try {
    executionHost = await executionCommandReconcilePass();
    errors.push(...executionHost.commands.errors);
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`execution-host reconcile pass failed: ${message}`);
    bundleErrors.push(`execution-host reconcile pass failed: ${message}`);
    log.error({ err: message }, "system_sweep execution-host reconcile threw");
  }

  let brain: SystemSweepSummary["brain"] = null;

  try {
    brain = await runBrainDecaySweep();
    errors.push(...brain.errors);
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`brain decay sweep failed: ${message}`);
    bundleErrors.push(`brain decay sweep failed: ${message}`);
    log.error({ err: message }, "system_sweep brain decay threw");
  }

  let brainReindex: SystemSweepSummary["brainReindex"] = null;

  try {
    brainReindex = await runBrainReindexSweep();
    errors.push(...brainReindex.errors);
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`brain reindex sweep failed: ${message}`);
    bundleErrors.push(`brain reindex sweep failed: ${message}`);
    log.error({ err: message }, "system_sweep brain reindex threw");
  }

  const gc = await runGcBundle();

  errors.push(...gc.errors);
  bundleErrors.push(...gc.bundleErrors);

  const summary = {
    keepalive,
    reconcile,
    syncRecovery,
    cost,
    executionHost,
    brain,
    brainReindex,
    workspace: gc.workspace,
    workspaceReconciliation: gc.workspaceReconciliation,
    revision: gc.revision,
    capabilities: gc.capabilities,
    ephemeralAgent: gc.ephemeralAgent,
    contextMount: gc.contextMount,
    agentMaterialization: gc.agentMaterialization,
    evaluationEvidence: gc.evaluationEvidence,
    plainAgentDirectory: gc.plainAgentDirectory,
    worktreesPreserved: gc.workspace?.preserved ?? 0,
    worktreesRemoved: gc.workspace?.pruned ?? 0,
    revisionsRemoved: gc.revision?.deleted ?? 0,
    errors,
    bundleErrors,
  };

  log.info({ ...summary, errorCount: errors.length }, "system_sweep completed");

  return summary;
}

function gcFailureMessages(
  workspace: WorkspaceGcSummary | null,
  revision: RevisionGcSummary | null,
  capabilities: SystemSweepSummary["capabilities"],
): string[] {
  const errors: string[] = [];

  if (workspace && workspace.skippedUnpreserved > 0) {
    errors.push(
      `${workspace.skippedUnpreserved} workspace(s) skipped: preserve failed (left for retry)`,
    );
  }
  if (workspace && workspace.failed > 0) {
    errors.push(`${workspace.failed} workspace(s) errored during GC`);
  }
  if (revision && revision.failed > 0) {
    errors.push(
      `${revision.failed} revision cache dir(s) failed to remove (row deleted, dir orphaned on disk)`,
    );
  }
  if (capabilities && capabilities.failed > 0) {
    errors.push(
      `${capabilities.failed} capability dir(s) failed to remove (left for retry)`,
    );
  }

  return errors;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
