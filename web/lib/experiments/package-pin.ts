import "server-only";

import type { ExperimentVariant } from "@/lib/experiments/types";

import { and, eq, inArray } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { resolvePinnedFlowRevisionForRefId } from "@/lib/packages/pin";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { tasks, flows, packageInstalls, flowRevisions } =
  schemaModule as unknown as Record<string, any>;

// ADR-129 §b: batch-validate every variant `packagePin` against the pin
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

// ADR-129 §b: the variant-editor picker feed — the T4-valid install set for
// the task's flow: Installed + trusted (allow-list) installs shipping a
// member revision with the flow's ref id. Never free-text; the client only
// ever picks from this server-filtered set.
export type ExperimentPinOption = {
  packageInstallId: string;
  packageName: string;
  versionLabel: string;
  kind: "local_cut" | "upstream";
};

export async function listEligiblePinInstalls(args: {
  db: any;
  taskId: string;
}): Promise<ExperimentPinOption[]> {
  const taskRows = await args.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, args.taskId));
  const task = taskRows[0];

  if (!task?.flowId) return [];

  const flowRows = await args.db
    .select()
    .from(flows)
    .where(eq(flows.id, task.flowId));
  const flowRow = flowRows[0];

  if (!flowRow) return [];

  const rows = await args.db
    .select({
      packageInstallId: packageInstalls.id,
      packageName: packageInstalls.name,
      versionLabel: packageInstalls.versionLabel,
      sourceLocalPackageId: packageInstalls.sourceLocalPackageId,
    })
    .from(packageInstalls)
    .innerJoin(
      flowRevisions,
      and(
        eq(flowRevisions.resolvedRevision, packageInstalls.resolvedRevision),
        eq(flowRevisions.flowRefId, flowRow.flowRefId),
      ),
    )
    .where(
      and(
        eq(packageInstalls.packageStatus, "Installed"),
        inArray(packageInstalls.trustStatus, ["trusted", "trusted_by_policy"]),
      ),
    );

  return rows.map((row: Record<string, any>) => ({
    packageInstallId: row.packageInstallId,
    packageName: row.packageName,
    versionLabel: row.versionLabel,
    kind: row.sourceLocalPackageId ? ("local_cut" as const) : ("upstream" as const),
  }));
}
