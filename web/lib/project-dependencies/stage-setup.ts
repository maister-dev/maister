import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { InstalledRevision } from "@/lib/flows";
import type { PreparedCapability } from "@/lib/capabilities/import";

import { runMaterialSetup } from "./setup";

import { requiresExplicitNativeFindingsEnablement } from "@/lib/flows/enablement-states";
import { MaisterError } from "@/lib/errors";

type SetupMaterial = Parameters<typeof runMaterialSetup>[0];

async function settle(input: SetupMaterial, memberRef: string): Promise<void> {
  if ((await runMaterialSetup(input)) === "failed")
    throw new MaisterError("FLOW_INSTALL", "Trusted dependency setup failed", {
      details: { reason: "setup_failed", memberRef },
    });
}

export async function stageFlowSetup(
  db: Db,
  revision: InstalledRevision,
  memberRef: string,
  signal: AbortSignal,
): Promise<void> {
  if (
    revision.setupStatus !== "pending" ||
    requiresExplicitNativeFindingsEnablement(revision.manifest)
  )
    return;
  await settle(
    {
      kind: "flow",
      target: revision.installedPath,
      revision: revision.revisionId,
      db,
      signal,
    },
    memberRef,
  );
}

export async function stageCapabilitySetup(
  db: Db,
  material: PreparedCapability,
  memberRef: string,
  signal: AbortSignal,
): Promise<void> {
  if (!material.hasSetup) return;
  await settle(
    {
      kind: "capability",
      target: material.installedPath,
      revision: material.resolvedRevision,
      contentWitness: material.contentWitness,
      db,
      signal,
    },
    memberRef,
  );
}
