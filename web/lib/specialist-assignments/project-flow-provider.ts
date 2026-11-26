import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { RunResultContract } from "@/lib/run-results/types";
import type { ProjectCoordinatorFlowSnapshot } from "./types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { requireReadyDeclaredFlowRunner } from "@/lib/acp-runners/declared-flow-runner";
import { assertProjectFlowCapabilities } from "@/lib/flows/project-capability-refs";
import {
  resolveFlowRef,
  formatFlowRefError,
} from "@/lib/flows/resolve-flow-ref";
import { resolveEffectiveFlowRevision } from "@/lib/flows/lifecycle";
import { assertFlowLaunchable } from "@/lib/flows/launchability-gate";
import {
  classifyStoredFlowManifest,
  flowManifestIncompatibilityDetails,
} from "@/lib/flows/manifest-parser";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { projectFlowSetupOwner } from "@/lib/execution-host/selected-endpoint";

export type ProjectCoordinatorProvider = Readonly<{
  snapshot: ProjectCoordinatorFlowSnapshot;
  resultContract: Extract<RunResultContract, { kind: "flow_export" }>;
}>;

const providerSchema = z.object({
  id: z.string().min(1),
  flowRefId: z.string().min(1),
  enabledRevisionId: z.string().nullable(),
  versionBinding: z.string(),
  enablementState: z.string(),
  trustStatus: z.string(),
});
const revisionSchema = z.object({
  id: z.string().min(1),
  flowRefId: z.string().min(1),
  resolvedRevision: z.string().min(1),
  installedPath: z.string().min(1),
  packageStatus: z.string(),
  setupStatus: z.string(),
  execTrust: z.string(),
  schemaVersion: z.number().int(),
  engineMin: z.string().nullable(),
  engineMax: z.string().nullable(),
  manifest: z.unknown(),
});

/** Retain the configured trusted provider independently of transient runner availability. */
export async function loadProjectCoordinatorProvider(
  tx: SqlTransaction,
  projectId: string,
  flowReference: string,
): Promise<ProjectCoordinatorProvider> {
  const resolution = await resolveFlowRef(projectId, flowReference, tx);

  if (!resolution.ok)
    throw new MaisterError(
      "PRECONDITION",
      formatFlowRefError(resolution.detail),
    );
  const provider = providerSchema.safeParse(
    (
      await tx.execute(sql`
    SELECT id,flow_ref_id AS "flowRefId",enabled_revision_id AS "enabledRevisionId",
      version_binding AS "versionBinding",enablement_state AS "enablementState",trust_status AS "trustStatus"
    FROM flows WHERE id=${resolution.flowId} AND project_id=${projectId} FOR SHARE
  `)
    ).rows[0],
  );

  if (!provider.success)
    throw new MaisterError(
      "PRECONDITION",
      "The configured project coordinator provider is unavailable",
    );
  const flow = provider.data;
  const revisionId = await resolveEffectiveFlowRevision(tx, flow);
  const decoded = revisionSchema.safeParse(
    (
      await tx.execute(sql`
    SELECT id,flow_ref_id AS "flowRefId",resolved_revision AS "resolvedRevision",installed_path AS "installedPath",
      package_status AS "packageStatus",setup_status AS "setupStatus",exec_trust AS "execTrust",
      schema_version AS "schemaVersion",engine_min AS "engineMin",engine_max AS "engineMax",manifest
    FROM flow_revisions WHERE id=${revisionId} AND flow_ref_id=${flow.flowRefId} FOR SHARE
  `)
    ).rows[0],
  );

  assertFlowLaunchable(
    flow.flowRefId,
    flow,
    decoded.success ? decoded.data : null,
    projectFlowSetupOwner(projectId),
  );
  if (!decoded.success || decoded.data.execTrust !== "trusted")
    throw new MaisterError(
      "PRECONDITION",
      "The exact trusted project coordinator revision is unavailable",
    );
  const revision = decoded.data;
  const stored = classifyStoredFlowManifest(revision.manifest);

  if (!stored.compatible)
    throw new MaisterError(
      "CONFIG",
      "The project coordinator manifest is incompatible",
      {
        details: flowManifestIncompatibilityDetails(stored.reason),
      },
    );
  await assertProjectFlowCapabilities(tx, projectId, stored.manifest);
  await requireReadyDeclaredFlowRunner(tx, flow.id);

  const resultContract = await resolveFlowExportContract({
    flowRefId: flow.flowRefId,
    manifest: stored.manifest,
    revision,
  });

  if (
    !resultContract ||
    resultContract.kind !== "flow_export" ||
    resultContract.required !== true
  )
    throw new MaisterError(
      "PRECONDITION",
      "Project coordinator work requires a pinned mandatory public Flow result",
    );

  return {
    snapshot: {
      flowId: flow.id,
      flowRefId: flow.flowRefId,
      flowRevisionId: revision.id,
      resolvedRevision: revision.resolvedRevision,
      manifestSha256: contentDigest(revision.manifest),
    },
    resultContract,
  };
}

/** Current enablement cannot silently select a new graph for an already requested assignment. */
export async function assertProjectCoordinatorProvider(
  tx: SqlTransaction,
  projectId: string,
  expected: ProjectCoordinatorFlowSnapshot,
): Promise<void> {
  const current = await loadProjectCoordinatorProvider(
    tx,
    projectId,
    expected.flowId,
  );

  if (contentDigest(current.snapshot) !== contentDigest(expected))
    throw new MaisterError(
      "CONFLICT",
      "The project coordinator differs from the assignment's exact retained Flow witness",
      { details: { reason: "project_assignment_provider_changed" } },
    );
}
