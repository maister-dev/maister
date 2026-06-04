import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { rm } from "node:fs/promises";

import { and, eq, ne } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";
import { ensureSymlink, installRevision, runRevisionSetup } from "@/lib/flows";
import { projectFlowSymlinkPath } from "@/lib/flow-paths";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { flows, flowRevisions, projects, runs } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-lifecycle",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = any;

type FlowEnablementRow = {
  id: string;
  projectId: string;
  flowRefId: string;
  source: string;
  enabledRevisionId: string | null;
  enablementState: string;
  trustStatus: string;
};

type RevisionRow = {
  id: string;
  flowRefId: string;
  source: string;
  versionLabel: string;
  resolvedRevision: string;
  installedPath: string;
  manifest: FlowYamlV1;
  schemaVersion: number;
  engineMin: string | null;
  engineMax: string | null;
  setupStatus: string;
  packageStatus: string;
};

async function loadFlow(
  db: Db,
  projectId: string,
  flowRefId: string,
): Promise<FlowEnablementRow> {
  const rows = await db
    .select()
    .from(flows)
    .where(and(eq(flows.projectId, projectId), eq(flows.flowRefId, flowRefId)));
  const flow = rows[0];

  if (!flow) {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${flowRefId}" is not configured for project ${projectId}`,
    );
  }

  return flow;
}

// Resolve a revision and bind it to the project's flow. Revisions are globally
// content-addressed by (flowRefId, resolvedRevision), so matching on flowRefId
// alone would let a project enable/rollback to a revision installed by another
// project from a DIFFERENT (possibly untrusted) source under the same flow id.
// `expectedSource` is the project's own declared source for the flow; requiring
// rev.source === expectedSource closes that cross-source trust hole (ADR-021).
async function loadRevisionForFlow(
  db: Db,
  flowRefId: string,
  revisionId: string,
  expectedSource: string,
): Promise<RevisionRow> {
  const rows = await db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, revisionId));
  const rev = rows[0];

  if (!rev || rev.flowRefId !== flowRefId) {
    throw new MaisterError(
      "PRECONDITION",
      `revision ${revisionId} not found for flow "${flowRefId}"`,
    );
  }
  if (rev.source !== expectedSource) {
    throw new MaisterError(
      "PRECONDITION",
      `revision ${revisionId} was installed from a different source than this project's "${flowRefId}" flow`,
    );
  }

  return rev;
}

function assertEnableable(flow: FlowEnablementRow, rev: RevisionRow): void {
  if (rev.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `revision ${rev.id} is ${rev.packageStatus}, not Installed`,
    );
  }
  if (flow.trustStatus === "untrusted") {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${flow.flowRefId}" is untrusted — confirm trust before enabling`,
    );
  }
  // Note: `setupStatus === "pending"` is NOT refused here — enableRevision runs
  // setup.sh now that trust is confirmed. A FAILED setup is reflected as
  // packageStatus='Failed', already caught by the check above.
  if (!isSchemaVersionSupported(rev.schemaVersion)) {
    throw new MaisterError(
      "CONFIG",
      `revision ${rev.id} requires unsupported manifest schemaVersion ${rev.schemaVersion}`,
    );
  }

  const compat = isEngineCompatible(
    rev.engineMin ?? undefined,
    rev.engineMax ?? undefined,
  );

  if (!compat.compatible) {
    throw new MaisterError(
      "CONFIG",
      `revision ${rev.id} is incompatible with this MAIster engine: ${compat.reason}`,
    );
  }
}

async function repointSymlink(
  db: Db,
  projectId: string,
  flowRefId: string,
  target: string,
): Promise<void> {
  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId));
  const slug = rows[0]?.slug;

  if (!slug) return;

  try {
    await ensureSymlink({
      target,
      linkPath: projectFlowSymlinkPath(process.cwd(), slug, flowRefId),
    });
  } catch (err) {
    log.warn(
      { projectId, flowRefId, err: (err as Error).message },
      "symlink repoint failed (non-fatal; runtime uses pinned installed_path)",
    );
  }
}

// Switch a project's enabled revision to `revisionId` and refresh the
// denormalized flows cache from the revision's manifest.
export async function enableRevision(args: {
  projectId: string;
  flowRefId: string;
  revisionId: string;
  db?: Db;
}): Promise<void> {
  const db = args.db ?? getDb();
  const flow = await loadFlow(db, args.projectId, args.flowRefId);
  const rev = await loadRevisionForFlow(
    db,
    args.flowRefId,
    args.revisionId,
    flow.source,
  );

  assertEnableable(flow, rev);

  // Trust is now confirmed (flow.trustStatus != untrusted via assertEnableable).
  // Run the deferred setup.sh for an untrusted-then-trusted revision before
  // enabling. A setup failure marks the revision Failed and refuses enable.
  if (rev.setupStatus === "pending") {
    const setupStatus = await runRevisionSetup({
      db,
      revisionId: rev.id,
      installedPath: rev.installedPath,
      signal: undefined,
    });

    if (setupStatus === "failed") {
      throw new MaisterError(
        "PRECONDITION",
        `revision ${rev.id} setup.sh failed — package marked Failed`,
      );
    }
  }

  const manifest = rev.manifest;

  // Atomic switch (Codex finding #2): lock the revision row and re-verify it is
  // still Installed under the lock, so a concurrent removeRevision (which also
  // locks the row) cannot leave the project enabled to a Removed revision.
  await db.transaction(async (tx: Db) => {
    const locked = await tx
      .select({ packageStatus: flowRevisions.packageStatus })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, rev.id))
      .for("update");
    const current = locked[0]?.packageStatus;

    if (current !== "Installed") {
      throw new MaisterError(
        "CONFLICT",
        `revision ${rev.id} is ${current ?? "missing"}, cannot enable`,
      );
    }

    await tx
      .update(flows)
      .set({
        enabledRevisionId: rev.id,
        enablementState: "Enabled",
        source: rev.source,
        version: rev.versionLabel,
        revision: rev.resolvedRevision,
        installedPath: rev.installedPath,
        manifest,
        schemaVersion: rev.schemaVersion,
        updatedAt: new Date(),
      })
      .where(eq(flows.id, flow.id));
  });

  await repointSymlink(db, args.projectId, args.flowRefId, rev.installedPath);

  log.info(
    {
      projectId: args.projectId,
      flowRefId: args.flowRefId,
      from: flow.enabledRevisionId,
      to: rev.id,
    },
    "flow revision enabled",
  );
}

// Roll the project's enabled revision back to an older installed revision.
// Identical mechanics to enableRevision; kept separate for an explicit audit log.
export async function rollbackFlow(args: {
  projectId: string;
  flowRefId: string;
  revisionId: string;
  db?: Db;
}): Promise<void> {
  log.info(
    {
      projectId: args.projectId,
      flowRefId: args.flowRefId,
      to: args.revisionId,
    },
    "flow rollback requested",
  );

  await enableRevision(args);
}

export async function disableFlow(args: {
  projectId: string;
  flowRefId: string;
  db?: Db;
}): Promise<void> {
  const db = args.db ?? getDb();
  const flow = await loadFlow(db, args.projectId, args.flowRefId);

  await db
    .update(flows)
    .set({ enablementState: "Disabled", updatedAt: new Date() })
    .where(eq(flows.id, flow.id));

  log.info(
    {
      projectId: args.projectId,
      flowRefId: args.flowRefId,
      from: flow.enablementState,
    },
    "flow disabled (in-flight runs keep their pinned revision)",
  );
}

// Install a NEW immutable revision beside the current one and mark the project
// as UpdateAvailable. Does NOT auto-enable — enablement is an explicit action.
export async function upgradeFlow(args: {
  projectId: string;
  flowRefId: string;
  source: string;
  version: string;
  db?: Db;
}): Promise<{ revisionId: string }> {
  const db = args.db ?? getDb();
  const flow = await loadFlow(db, args.projectId, args.flowRefId);

  // Upgrade installs a new revision of the SAME flow from the SAME source.
  // Re-sourcing a flow id (different upstream) is install/re-install, not
  // upgrade — and would bypass the source-scoped enable boundary, so reject it.
  if (args.source !== flow.source) {
    throw new MaisterError(
      "PRECONDITION",
      `upgrade source "${args.source}" differs from the project's "${args.flowRefId}" flow source "${flow.source}" — re-install to change source`,
    );
  }

  const rev = await installRevision({
    source: args.source,
    version: args.version,
    flowId: args.flowRefId,
    db,
  });

  if (flow.enabledRevisionId && flow.enabledRevisionId !== rev.revisionId) {
    await db
      .update(flows)
      .set({ enablementState: "UpdateAvailable", updatedAt: new Date() })
      .where(eq(flows.id, flow.id));
  }

  log.info(
    {
      projectId: args.projectId,
      flowRefId: args.flowRefId,
      candidate: rev.revisionId,
      enabled: flow.enabledRevisionId,
    },
    "flow upgrade candidate installed",
  );

  return { revisionId: rev.revisionId };
}

export async function setTrust(args: {
  projectId: string;
  flowRefId: string;
  trusted: boolean;
  db?: Db;
}): Promise<void> {
  const db = args.db ?? getDb();
  const flow = await loadFlow(db, args.projectId, args.flowRefId);
  const next = args.trusted ? "trusted" : "untrusted";

  if (flow.trustStatus === "trusted_by_policy" && !args.trusted) {
    log.warn(
      { projectId: args.projectId, flowRefId: args.flowRefId },
      "operator override: downgrading trusted_by_policy to untrusted",
    );
  }

  await db
    .update(flows)
    .set({ trustStatus: next, updatedAt: new Date() })
    .where(eq(flows.id, flow.id));

  log.info(
    { projectId: args.projectId, flowRefId: args.flowRefId, trustStatus: next },
    "flow trust updated",
  );
}

// Remove a revision. Refused while any run references it OR it is any project's
// enabled revision (CONFLICT). Automatic GC of unreferenced revisions is M19.
export async function removeRevision(args: {
  flowRefId: string;
  revisionId: string;
  // The requesting project's declared source for the flow — a project may only
  // remove revisions installed from its own source (ADR-021 trust boundary).
  expectedSource: string;
  db?: Db;
}): Promise<void> {
  const db = args.db ?? getDb();
  // Validate source-scope + flow binding and capture the cache path up front.
  const rev = await loadRevisionForFlow(
    db,
    args.flowRefId,
    args.revisionId,
    args.expectedSource,
  );

  // Atomic remove (Codex finding #2): lock the revision row, re-check the
  // referencing-run and enabled-anywhere guards UNDER the lock, then CAS the
  // status to Removed. enableRevision locks the same row, so the two are
  // mutually exclusive — a concurrent enable cannot read the revision as
  // Installed and then race the deletion.
  await db.transaction(async (tx: Db) => {
    const locked = await tx
      .select({ packageStatus: flowRevisions.packageStatus })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, args.revisionId))
      .for("update");

    if ((locked[0]?.packageStatus ?? "Removed") === "Removed") {
      throw new MaisterError(
        "CONFLICT",
        `revision ${args.revisionId} is already removed`,
      );
    }

    const refRuns = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.flowRevisionId, args.revisionId))
      .limit(1);

    if (refRuns.length > 0) {
      throw new MaisterError(
        "CONFLICT",
        `revision ${args.revisionId} is still referenced by at least one run`,
      );
    }

    const enabledBy = await tx
      .select({ id: flows.id })
      .from(flows)
      .where(eq(flows.enabledRevisionId, args.revisionId))
      .limit(1);

    if (enabledBy.length > 0) {
      throw new MaisterError(
        "CONFLICT",
        `revision ${args.revisionId} is the enabled revision of a project`,
      );
    }

    const updated = await tx
      .update(flowRevisions)
      .set({ packageStatus: "Removed" })
      .where(
        and(
          eq(flowRevisions.id, args.revisionId),
          ne(flowRevisions.packageStatus, "Removed"),
        ),
      )
      .returning({ id: flowRevisions.id });

    if (updated.length === 0) {
      throw new MaisterError(
        "CONFLICT",
        `revision ${args.revisionId} could not be removed (concurrent change)`,
      );
    }
  });

  // Cache deletion AFTER the row is committed Removed — safe because the
  // referencing/enabled guards held under the lock.
  await rm(rev.installedPath, { recursive: true, force: true }).catch((err) =>
    log.warn(
      { installedPath: rev.installedPath, err: (err as Error).message },
      "cache rm failed (revision marked Removed in DB)",
    ),
  );

  log.info(
    { flowRefId: args.flowRefId, revisionId: args.revisionId },
    "flow revision removed",
  );
}

export type ContractDiff = { added: string[]; removed: string[] };

export type UpgradePreview = {
  fromRevisionId: string | null;
  toRevisionId: string;
  schemaVersionChanged: boolean;
  setupChanged: boolean;
  steps: ContractDiff;
  gates: ContractDiff;
  artifacts: ContractDiff;
  capabilities: ContractDiff;
  externalOps: ContractDiff;
};

function diff(
  from: string[] | undefined,
  to: string[] | undefined,
): ContractDiff {
  const a = new Set(from ?? []);
  const b = new Set(to ?? []);

  return {
    added: [...b].filter((x) => !a.has(x)),
    removed: [...a].filter((x) => !b.has(x)),
  };
}

function stepIds(m: FlowYamlV1 | undefined): string[] {
  return (m?.steps ?? []).map((s) => s.id);
}

// Structured contract diff of the enabled revision vs a candidate revision.
export async function upgradePreview(args: {
  flowRefId: string;
  enabledRevisionId: string | null;
  candidateRevisionId: string;
  // The requesting project's declared source for the flow (source-scope bound).
  expectedSource: string;
  db?: Db;
}): Promise<UpgradePreview> {
  const db = args.db ?? getDb();
  const cand = await loadRevisionForFlow(
    db,
    args.flowRefId,
    args.candidateRevisionId,
    args.expectedSource,
  );

  let fromManifest: FlowYamlV1 | undefined;
  let fromSchema: number | undefined;
  let fromSetup = false;

  if (args.enabledRevisionId) {
    const fromRows = await db
      .select()
      .from(flowRevisions)
      .where(eq(flowRevisions.id, args.enabledRevisionId));
    const from = fromRows[0] as RevisionRow | undefined;

    fromManifest = from?.manifest;
    fromSchema = from?.schemaVersion;
    fromSetup = from?.manifest?.setup !== undefined;
  }

  const toManifest = cand.manifest;

  return {
    fromRevisionId: args.enabledRevisionId,
    toRevisionId: cand.id,
    schemaVersionChanged:
      fromSchema !== undefined && fromSchema !== cand.schemaVersion,
    setupChanged: fromSetup !== (toManifest.setup !== undefined),
    steps: diff(stepIds(fromManifest), stepIds(toManifest)),
    gates: diff(fromManifest?.gates, toManifest.gates),
    artifacts: diff(fromManifest?.artifacts, toManifest.artifacts),
    capabilities: diff(fromManifest?.capabilities, toManifest.capabilities),
    externalOps: diff(fromManifest?.external_ops, toManifest.external_ops),
  };
}
