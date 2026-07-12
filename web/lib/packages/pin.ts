import "server-only";

import { and, eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (see catalog.ts).
const { packageInstalls, flowRevisions } = schemaModule as unknown as Record<
  string,
  any
>;

// ADR-129 §a: the ephemeral-pin allow-list matrix — resolve the flow revision
// an explicitly named `package_installs` row ships for a flow ref id.
// Refusals: unknown install → CONFIG; not Installed / untrusted →
// PRECONDITION; no member revision with the flow's ref id → CONFIG naming
// both ids. Shared by the launch pin (`launchRunStaged`), the try_once
// translation, and the experiments create/fan-out batch validation — one
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
