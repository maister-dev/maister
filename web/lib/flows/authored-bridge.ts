import "server-only";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import {
  authoredFlowPackageBodyFromUnknown,
  writeAuthoredFlowPackageDirectory,
} from "@/lib/flows/package-authoring";
import { installAuthoredFlowPackageBridge } from "@/lib/flows";

const log = pino({
  name: "authored-bridge",
  level: process.env.LOG_LEVEL ?? "info",
});

type BridgeDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

type CapRow = {
  kind: string;
  slug: string;
  source_flow_ref_id: string | null;
};

type ProjectRow = {
  id: string;
  slug: string;
  repo_path: string;
};

export type BridgePublishedAuthoredFlowResult = {
  flowRowId: string;
  revisionId: string;
};

export async function bridgePublishedAuthoredFlow(args: {
  projectSlug: string;
  projectId: string;
  capId: string;
  // The published authored_capability_revisions row (returned by publishAuthoredCapabilityLocal).
  revision: {
    id: string;
    revisionNumber: number;
    contentHash: string;
    body: Record<string, unknown>;
    title: string;
  };
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
}): Promise<BridgePublishedAuthoredFlowResult> {
  const db: BridgeDb = args.db ?? (getDb() as unknown as BridgeDb);

  log.debug(
    {
      projectSlug: args.projectSlug,
      projectId: args.projectId,
      capId: args.capId,
      revisionId: args.revision.id,
      revisionNumber: args.revision.revisionNumber,
    },
    "authored bridge start",
  );

  // Load the authored capability to get kind + slug + source_flow_ref_id.
  const capResult = await db.execute(sql`
    SELECT kind, slug, source_flow_ref_id
    FROM authored_capabilities
    WHERE id = ${args.capId}
      AND project_id = ${args.projectId}
    LIMIT 1
  `);
  const cap = (capResult.rows ?? [])[0] as CapRow | undefined;

  if (!cap) {
    throw new MaisterError(
      "CONFIG",
      `authored capability not found for bridge: ${args.capId}`,
    );
  }

  if (cap.kind !== "flow") {
    throw new MaisterError(
      "CONFIG",
      `bridge called for non-flow capability: ${args.capId} (kind=${cap.kind})`,
    );
  }

  // Load project repoPath (workspaceRoot for symlink placement).
  const projResult = await db.execute(sql`
    SELECT id, slug, repo_path
    FROM projects
    WHERE id = ${args.projectId}
    LIMIT 1
  `);
  const proj = (projResult.rows ?? [])[0] as ProjectRow | undefined;

  if (!proj) {
    throw new MaisterError(
      "CONFIG",
      `project not found for bridge: ${args.projectId}`,
    );
  }

  // Derive the flowId: use source_flow_ref_id if this is an edit of an
  // installed flow, otherwise use the capability slug (net-new authored flow).
  const flowId = cap.source_flow_ref_id ?? cap.slug;

  // Build the authored package body from the published revision's body.
  const packageBody = authoredFlowPackageBodyFromUnknown({
    value: args.revision.body,
    fallbackMetadata: {
      slug: cap.slug,
      name: args.revision.title,
    },
    context: `${args.projectSlug}/${args.capId} authored-bridge`,
  });

  // Version label: stable, derived from content hash.
  const versionLabel = `local-${args.revision.contentHash.slice(0, 12)}`;

  let tempDir: string | null = null;

  try {
    // mkdtemp gives us the parent; writeAuthoredFlowPackageDirectory requires
    // that the target does NOT exist yet (it creates it via tmp+rename).
    tempDir = await mkdtemp(
      path.join(
        os.tmpdir(),
        `maister-authored-bridge-${args.capId.slice(0, 8)}-`,
      ),
    );
    const packageDir = path.join(tempDir, "pkg");

    log.debug(
      {
        tempDir,
        packageDir,
        flowId,
        versionLabel,
        projectSlug: args.projectSlug,
      },
      "authored bridge writing temp package dir",
    );

    await writeAuthoredFlowPackageDirectory(packageBody, packageDir);

    const result = await installAuthoredFlowPackageBridge(
      {
        source: packageDir,
        version: versionLabel,
        projectId: args.projectId,
        projectSlug: args.projectSlug,
        flowId,
        workspaceRoot: proj.repo_path,
        db: args.db,
        execTrustOverride: "untrusted",
      },
      "trusted_by_policy",
    );

    log.info(
      {
        projectSlug: args.projectSlug,
        capId: args.capId,
        flowId,
        flowRowId: result.flowRowId,
        revisionId: result.revisionId,
        versionLabel,
        trustStatus: result.trustStatus,
        enablementState: result.enablementState,
      },
      "authored bridge complete",
    );

    return {
      flowRowId: result.flowRowId,
      revisionId: result.revisionId,
    };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      log.debug({ tempDir }, "authored bridge temp dir cleaned up");
    }
  }
}
