import "server-only";

import type { RevisionGcSummary } from "@/lib/gc/revision-gc";
import type { WorkspaceGcSummary } from "@/lib/gc/workspace-gc";

import pino from "pino";

import { runCapabilitiesCleanupSweep } from "@/lib/capabilities/cleanup";
import { runRevisionGcSweep } from "@/lib/gc/revision-gc";
import { runWorkspaceGcSweep } from "@/lib/gc/workspace-gc";
import { runReconcileSweep } from "@/lib/reconcile";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";

export type GcCompatibilitySummary = {
  worktreesPreserved: number;
  worktreesRemoved: number;
  revisionsRemoved: number;
  errors: string[];
};

export type SystemSweepSummary = GcCompatibilitySummary & {
  keepalive: Awaited<ReturnType<typeof runSweepTick>> | null;
  reconcile: Awaited<ReturnType<typeof runReconcileSweep>> | null;
  workspace: WorkspaceGcSummary | null;
  revision: RevisionGcSummary | null;
  capabilities: Awaited<ReturnType<typeof runCapabilitiesCleanupSweep>> | null;
};

const log = pino({
  name: "scheduler-system-sweeps",
  level: process.env.LOG_LEVEL ?? "info",
});

type GcBundleResult = {
  workspace: WorkspaceGcSummary | null;
  revision: RevisionGcSummary | null;
  capabilities: SystemSweepSummary["capabilities"];
  errors: string[];
};

async function runGcBundle(): Promise<GcBundleResult> {
  const errors: string[] = [];
  let workspace: WorkspaceGcSummary | null = null;
  let revision: RevisionGcSummary | null = null;
  let capabilities: SystemSweepSummary["capabilities"] = null;

  try {
    workspace = await runWorkspaceGcSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`workspace sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle workspace threw");
  }

  try {
    revision = await runRevisionGcSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`revision sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle revision threw");
  }

  try {
    capabilities = await runCapabilitiesCleanupSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`capabilities sweep failed: ${message}`);
    log.error({ err: message }, "gc bundle capabilities threw");
  }

  errors.push(...gcFailureMessages(workspace, revision, capabilities));

  return { workspace, revision, capabilities, errors };
}

export async function runSystemSweep(): Promise<SystemSweepSummary> {
  const errors: string[] = [];
  let keepalive: SystemSweepSummary["keepalive"] = null;
  let reconcile: SystemSweepSummary["reconcile"] = null;

  try {
    keepalive = await runSweepTick();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`keepalive sweep failed: ${message}`);
    log.error({ err: message }, "system_sweep keepalive threw");
  }

  try {
    reconcile = await runReconcileSweep();
  } catch (err) {
    const message = errorMessage(err);

    errors.push(`reconcile sweep failed: ${message}`);
    log.error({ err: message }, "system_sweep reconcile threw");
  }

  const gc = await runGcBundle();

  errors.push(...gc.errors);

  const summary = {
    keepalive,
    reconcile,
    workspace: gc.workspace,
    revision: gc.revision,
    capabilities: gc.capabilities,
    worktreesPreserved: gc.workspace?.preserved ?? 0,
    worktreesRemoved: gc.workspace?.pruned ?? 0,
    revisionsRemoved: gc.revision?.deleted ?? 0,
    errors,
  };

  log.info({ ...summary, errorCount: errors.length }, "system_sweep completed");

  return summary;
}

export async function runGcCompatibilitySweep(): Promise<GcCompatibilitySummary> {
  const gc = await runGcBundle();

  return {
    worktreesPreserved: gc.workspace?.preserved ?? 0,
    worktreesRemoved: gc.workspace?.pruned ?? 0,
    revisionsRemoved: gc.revision?.deleted ?? 0,
    errors: gc.errors,
  };
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
