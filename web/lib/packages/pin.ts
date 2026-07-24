import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (see catalog.ts).
const { packageInstalls, flowRevisions, tasks, flows } =
  schemaModule as unknown as Record<string, any>;

// The variant/recipe package-pin picker feed — the valid install set for a
// task's flow: Installed + trusted (allow-list) installs shipping a member
// revision with the flow's ref id. Never free-text; the client only ever picks
// from this server-filtered set. Lives here (not lib/experiments) so the
// evaluations pin-options route survives the ADR-150 experiment removal.
export type PinInstallOption = {
  packageInstallId: string;
  packageName: string;
  versionLabel: string;
  kind: "local_cut" | "upstream";
};

export async function listEligiblePinInstalls(args: {
  db: any;
  taskId: string;
}): Promise<PinInstallOption[]> {
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
    kind: row.sourceLocalPackageId
      ? ("local_cut" as const)
      : ("upstream" as const),
  }));
}

// ADR-132 §a: the ephemeral-pin allow-list matrix — resolve the flow revision
// an explicitly named `package_installs` row ships for a flow ref id.
// Refusals: unknown install → CONFIG; not Installed / untrusted →
// PRECONDITION; no member revision with the flow's ref id → CONFIG naming
// both ids. Shared by the launch pin (`launchRunStaged`), the try_once
// translation, and the evaluation controlled-launch batch validation — one
// matrix, every entry point.
export async function resolvePinnedFlowRevisionForRefId(
  db: any,
  args: { flowRefId: string; packageInstallId: string },
): Promise<Record<string, any>> {
  const pinInstallRows = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, args.packageInstallId));
  const pinInstall = pinInstallRows[0];

  if (!pinInstall) {
    throw new MaisterError(
      "CONFIG",
      `packagePin install not found: ${args.packageInstallId}`,
    );
  }
  if (pinInstall.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `packagePin install ${pinInstall.id} is ${pinInstall.packageStatus}, not Installed`,
    );
  }
  if (
    pinInstall.trustStatus !== "trusted" &&
    pinInstall.trustStatus !== "trusted_by_policy"
  ) {
    // Allow-list, not a `=== "untrusted"` deny-list: a future trust status
    // (e.g. `pending`) must fail closed, never silently pin.
    throw new MaisterError(
      "PRECONDITION",
      `packagePin install ${pinInstall.id} is not trusted (${pinInstall.trustStatus}) — confirm trust before pinning a run to it`,
    );
  }

  const pinRevisionRows = await db
    .select()
    .from(flowRevisions)
    .where(
      and(
        eq(flowRevisions.flowRefId, args.flowRefId),
        eq(flowRevisions.resolvedRevision, pinInstall.resolvedRevision),
      ),
    )
    .limit(1);
  const pinnedRevision = pinRevisionRows[0];

  if (!pinnedRevision) {
    throw new MaisterError(
      "CONFIG",
      `packagePin install ${pinInstall.id} does not ship a revision of flow "${args.flowRefId}"`,
    );
  }

  return pinnedRevision;
}
