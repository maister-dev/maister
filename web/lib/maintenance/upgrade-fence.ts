import "server-only";

import { MaisterError } from "@/lib/errors";

// D9 step 2: the operator upgrade needs the installation to stop producing new
// history before the importer freezes and inventories its sources. The fence is
// an explicit operator declaration rather than a stored setting — the staged
// upgrade runs BEFORE the forward migrations that could carry one, and a
// database flag would be unreadable exactly when the schema is half-staged.
//
// It is enforced at the boundaries that already own admission: the run
// concurrency budget, the durable prompt ledger, the scheduler clock and the
// destructive sweep. Draining controls (cancel, checkpoint, HITL delivery,
// promotion of already-finished work) stay open — the operator still needs them.
export const UPGRADE_MAINTENANCE_ENV = "MAISTER_UPGRADE_MAINTENANCE";

const TRUTHY = ["1", "true", "on", "yes"];

export type UpgradeFencedOperation =
  // A new run entering the concurrency budget: launch, queue promotion, scratch
  // and package-assistant turns.
  | "run_admission"
  // A new agent turn on the durable prompt ledger, including a resume.
  | "prompt_turn"
  // The polymorphic scheduler clock: cron launches, agent ticks, sweeps.
  | "scheduler_tick"
  // The system sweep, which unlinks workspaces and runtime-object bytes.
  | "destructive_gc";

export function upgradeMaintenanceEngaged(): boolean {
  const raw = (process.env[UPGRADE_MAINTENANCE_ENV] ?? "").trim().toLowerCase();

  return TRUTHY.includes(raw);
}

export function assertUpgradeMaintenanceAllows(
  operation: UpgradeFencedOperation,
): void {
  if (!upgradeMaintenanceEngaged()) return;

  throw new MaisterError(
    "PRECONDITION",
    `${operation} is fenced while ${UPGRADE_MAINTENANCE_ENV} is set for the staged execution data-plane upgrade`,
    { details: { reason: "upgrade_maintenance_fence", operation } },
  );
}
