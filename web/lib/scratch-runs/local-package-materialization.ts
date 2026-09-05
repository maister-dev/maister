import "server-only";

import { rm } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { restoreAgentMaterialization } from "@/lib/agents/dirty-watchdog";
import { assertSafeAgentMaterializationPath } from "@/lib/agents/materialization-manifest";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";

const log = pino({
  name: "local-package-materialization",
  level: process.env.LOG_LEVEL ?? "info",
});

export type LocalPackageMaterializationCleanupResult = {
  readonly released: boolean;
  readonly capabilityRootRemoved: boolean;
};

/**
 * Reclaims materialization created for a project-less local-package assistant.
 * A failed manifest release deliberately leaves the capability root in place:
 * its run record is the retry authority used by the ownership GC.
 */
export async function cleanupLocalPackageAssistantMaterialization(args: {
  readonly workingDir: string;
  readonly runId: string;
}): Promise<LocalPackageMaterializationCleanupResult> {
  const workingDir = await assertSafeAgentMaterializationPath(
    args.workingDir,
    ".maister/capabilities",
  );

  try {
    await restoreAgentMaterialization(workingDir, args.runId);
  } catch (err) {
    log.error(
      {
        runId: args.runId,
        workingDir,
        error: err instanceof Error ? err.message : String(err),
      },
      "local-package materialization release failed; preserving retry state",
    );

    return { released: false, capabilityRootRemoved: false };
  }

  const capabilityRoot = capabilityMaterializationRootPath(
    workingDir,
    args.runId,
  );
  const capabilityRootRelative = path.relative(workingDir, capabilityRoot);

  try {
    await assertSafeAgentMaterializationPath(
      workingDir,
      capabilityRootRelative,
    );
    await rm(capabilityRoot, { recursive: true, force: true });
  } catch (err) {
    log.error(
      {
        runId: args.runId,
        workingDir,
        capabilityRoot,
        error: err instanceof Error ? err.message : String(err),
      },
      "local-package capability profile cleanup failed",
    );

    return { released: true, capabilityRootRemoved: false };
  }

  log.info(
    { runId: args.runId, workingDir, capabilityRoot },
    "local-package assistant materialization reclaimed",
  );

  return { released: true, capabilityRootRemoved: true };
}
