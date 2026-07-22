import "server-only";

import type { ExperimentVariant } from "@/lib/experiments/types";

import { eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { resolvePinnedFlowRevisionForRefId } from "@/lib/packages/pin";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { tasks, flows } = schemaModule as unknown as Record<string, any>;

// ADR-132 §b: batch-validate every variant `packagePin` against the pin
// matrix for the experiment task's flow. Runs at CREATE time (an experiment
// that is creatable now but unlaunchable later is a design defect) and again
// at launch fan-out BEFORE the first side effect (launch stays
// authoritative). No-op when no variant pins.
export async function assertVariantPackagePinsLaunchable(args: {
  db: any;
  taskId: string;
  variants: ExperimentVariant[];
}): Promise<void> {
  const pinned = args.variants.filter((variant) => variant.config.packagePin);

  if (pinned.length === 0) return;

  const taskRows = await args.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, args.taskId));
  const task = taskRows[0];

  if (!task?.flowId) {
    throw new MaisterError(
      "PRECONDITION",
      `experiment task ${args.taskId} has no flow — packagePin variants need a flow-bound task`,
    );
  }

  const flowRows = await args.db
    .select()
    .from(flows)
    .where(eq(flows.id, task.flowId));
  const flowRow = flowRows[0];

  if (!flowRow) {
    throw new MaisterError(
      "PRECONDITION",
      `flow not found for experiment task ${args.taskId}`,
    );
  }

  for (const variant of pinned) {
    await resolvePinnedFlowRevisionForRefId(args.db, {
      flowRefId: flowRow.flowRefId,
      packageInstallId: variant.config.packagePin!.packageInstallId,
    });
  }
}

// ADR-149: the picker feed moved to `lib/packages/pin.ts` (survives the
// experiment removal). Re-exported here for the legacy route until Phase 4/5
// deletes it — one implementation, no drift.
export {
  listEligiblePinInstalls,
  type PinInstallOption as ExperimentPinOption,
} from "@/lib/packages/pin";
