import "server-only";

import type { MaisterPackageManifest } from "@/lib/config.schema";

import { createHash, randomUUID } from "node:crypto";
import { cp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { and, eq, inArray, notInArray } from "drizzle-orm";
import pino from "pino";

import {
  installCapabilityRevision,
  runCapabilityRevisionSetup,
} from "@/lib/capabilities/import";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  installFlowPlugin,
  installRevision,
  runRevisionSetup,
} from "@/lib/flows";
import { resolvePackageSource } from "@/lib/packages/install";
import { redactUrl } from "@/lib/repo-source";

// FIXME(any): dual drizzle-orm peer-dep variants (see flows.ts).
const {
  packageInstalls,
  projectPackageAttachments,
  flows,
  flowRevisions,
  capabilityImports,
  capabilityRecords,
  runs,
} = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "package-attach",
  level: process.env.LOG_LEVEL ?? "info",
});

// Allow-list of run statuses that pin a revision against detach (never a
// deny-list of terminals — a future status must be rejected by default).
const ACTIVE_RUN_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "Review",
  "Crashed",
] as const;

// `manifest` jsonb on package_installs: the parsed spec + the content
// inventory (spec stays strict-schema-parseable on its own).
export type PackageInstallManifest = {
  spec: MaisterPackageManifest;
  inventory: { skills: string[]; agents: string[] };
};

function packageCachePath(name: string, resolvedRevision: string): string {
  // `name` is capabilityRefId-shaped (validated at manifest load); the
  // revision is a 40-hex digest/SHA — both safe path segments.
  return join(
    os.homedir(),
    ".maister",
    "packages",
    `${name}@${resolvedRevision.slice(0, 12)}`,
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

async function collectInventory(
  pkgRoot: string,
  manifest: MaisterPackageManifest,
): Promise<PackageInstallManifest["inventory"]> {
  const skills = new Set<string>();
  const agents = new Set<string>();

  for (const cap of manifest.capabilities) {
    const skillsDir = join(pkgRoot, cap.path, "skills");
    const agentsDir = join(pkgRoot, cap.path, "agents");

    try {
      for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) skills.add(entry.name);
      }
    } catch {
      // bundle without skills/ — fine
    }
    try {
      for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          agents.add(entry.name.replace(/\.md$/, ""));
        }
      }
    } catch {
      // bundle without agents/ — fine
    }
  }

  return { skills: [...skills].sort(), agents: [...agents].sort() };
}

export type InstallPackageRevisionResult = {
  id: string;
  name: string;
  versionLabel: string;
  resolvedRevision: string;
  reused: boolean;
};

// Platform-scope package install (ADR-087): resolve ONCE, copy the package
// bytes into the content-addressed platform cache, record the immutable
// `package_installs` row two-phase (Installing → Installed), and pre-install
// the member flow revisions GLOBALLY (flow_revisions only — project wiring
// happens at attach). `setup.sh` is NEVER executed here.
export async function installPackageRevision(opts: {
  source: string;
  version: string;
  path?: string;
  trustStatus?: "untrusted" | "trusted" | "trusted_by_policy";
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
}): Promise<InstallPackageRevisionResult> {
  const db = opts.db ?? getDb();
  const resolved = await resolvePackageSource({
    source: opts.source,
    version: opts.version,
    path: opts.path,
    signal: opts.signal,
  });

  try {
    const name = resolved.manifest.name;
    const [existing] = await db
      .select()
      .from(packageInstalls)
      .where(
        and(
          eq(packageInstalls.sourceUrl, opts.source),
          eq(packageInstalls.name, name),
          eq(packageInstalls.resolvedRevision, resolved.resolvedRevision),
        ),
      );

    if (
      existing &&
      existing.packageStatus === "Installed" &&
      (await pathExists(join(existing.installedPath, "maister-package.yaml")))
    ) {
      log.info(
        {
          id: existing.id,
          name,
          revision: resolved.resolvedRevision.slice(0, 12),
        },
        "package revision already installed — reused",
      );

      return {
        id: existing.id,
        name,
        versionLabel: existing.versionLabel,
        resolvedRevision: existing.resolvedRevision,
        reused: true,
      };
    }

    const id = existing?.id ?? randomUUID();
    const cachePath = packageCachePath(name, resolved.resolvedRevision);
    const inventory = await collectInventory(
      resolved.pkgRoot,
      resolved.manifest,
    );
    const manifestJson: PackageInstallManifest = {
      spec: resolved.manifest,
      inventory,
    };
    const manifestDigest = createHash("sha256")
      .update(JSON.stringify(resolved.manifest))
      .digest("hex");

    if (!existing) {
      await db.insert(packageInstalls).values({
        id,
        sourceUrl: opts.source,
        name,
        versionLabel: opts.version,
        resolvedRevision: resolved.resolvedRevision,
        manifest: manifestJson,
        manifestDigest,
        installedPath: cachePath,
        packageStatus: "Installing",
        trustStatus: opts.trustStatus ?? "untrusted",
      });
    } else {
      await db
        .update(packageInstalls)
        .set({ packageStatus: "Installing", updatedAt: new Date() })
        .where(eq(packageInstalls.id, id));
    }

    await rm(cachePath, { recursive: true, force: true });
    await cp(resolved.pkgRoot, cachePath, { recursive: true });

    // Pre-install member flow revisions (global, immutable, shared cache) so
    // per-project attach only wires enablement rows.
    for (const flow of resolved.manifest.flows) {
      await installRevision({
        source: join(cachePath, flow.path),
        version: resolved.versionLabel,
        flowId: flow.id,
        resolvedRevisionOverride: resolved.resolvedRevision,
        db,
        signal: opts.signal,
      });
    }

    await db
      .update(packageInstalls)
      .set({
        packageStatus: "Installed",
        manifest: manifestJson,
        manifestDigest,
        installedPath: cachePath,
        updatedAt: new Date(),
      })
      .where(eq(packageInstalls.id, id));

    log.info(
      {
        id,
        name,
        source: redactUrl(opts.source),
        revision: resolved.resolvedRevision.slice(0, 12),
        flows: resolved.manifest.flows.length,
        inventory: {
          skills: inventory.skills.length,
          agents: inventory.agents.length,
        },
      },
      "package revision installed",
    );

    return {
      id,
      name,
      versionLabel: opts.version,
      resolvedRevision: resolved.resolvedRevision,
      reused: false,
    };
  } catch (err) {
    log.warn(
      { source: redactUrl(opts.source), err: (err as Error).message },
      "package revision install failed",
    );
    throw err;
  } finally {
    await resolved.cleanup();
  }
}

function manifestOf(install: any): PackageInstallManifest {
  return install.manifest as PackageInstallManifest;
}

// Records ingested on attach carry this origin so the config SET/CLEAR sweep
// never disables them — attach/detach own their lifecycle (ADR-087).
const ATTACHMENT_ORIGIN = "package-attachment";

function ingestionRecords(
  manifest: PackageInstallManifest,
  install: any,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];

  for (const mcp of manifest.spec.mcps) {
    const env: Record<string, string> = {};

    for (const ref of mcp.env ?? []) env[ref.slice("env:".length)] = ref;
    records.push({
      capabilityRefId: mcp.id,
      kind: "mcp",
      label: mcp.description ?? mcp.id,
      material: {
        origin: ATTACHMENT_ORIGIN,
        packageInstallId: install.id,
        transport: mcp.transport,
        command: mcp.command,
        args: mcp.args ?? [],
        env,
        url: mcp.url,
      },
    });
  }

  for (const restriction of manifest.spec.restrictions) {
    records.push({
      capabilityRefId: restriction.id,
      kind: "restriction",
      label: restriction.id,
      material: {
        origin: ATTACHMENT_ORIGIN,
        packageInstallId: install.id,
        paths: restriction.paths,
      },
    });
  }

  return records;
}

async function writeIngestionRecords(
  tx: any,
  projectId: string,
  install: any,
): Promise<number> {
  const manifest = manifestOf(install);
  const records = ingestionRecords(manifest, install);

  for (const record of records) {
    await tx
      .insert(capabilityRecords)
      .values({
        id: randomUUID(),
        projectId,
        capabilityRefId: record.capabilityRefId,
        kind: record.kind,
        label: record.label,
        source: "flow-package",
        version: install.versionLabel,
        revision: install.resolvedRevision,
        agents: ["claude", "codex", "gemini", "opencode", "mimo"],
        enforceability: "instructed",
        selectedByDefault: true,
        selectable: true,
        material: record.material,
        disabledAt: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          capabilityRecords.projectId,
          capabilityRecords.source,
          capabilityRecords.kind,
          capabilityRecords.capabilityRefId,
        ],
        set: {
          label: record.label,
          version: install.versionLabel,
          revision: install.resolvedRevision,
          material: record.material,
          selectable: true,
          disabledAt: null,
          updatedAt: new Date(),
        },
      });
  }

  return records.length;
}

async function deleteIngestionRecords(
  tx: any,
  projectId: string,
  install: any,
): Promise<void> {
  const manifest = manifestOf(install);
  const refIds = [
    ...manifest.spec.mcps.map((m) => m.id),
    ...manifest.spec.restrictions.map((r) => r.id),
  ];

  if (refIds.length === 0) return;

  await tx
    .delete(capabilityRecords)
    .where(
      and(
        eq(capabilityRecords.projectId, projectId),
        eq(capabilityRecords.source, "flow-package"),
        inArray(capabilityRecords.capabilityRefId, refIds),
      ),
    );
}

// Installs the member flows + capability bundles into the PROJECT inside the
// caller's transaction and returns the member row ids (shared by attach and
// upgrade).
async function wireMembers(
  tx: any,
  opts: {
    projectId: string;
    projectSlug: string;
    workspaceRoot?: string;
    install: any;
    signal?: AbortSignal;
  },
): Promise<{ flowRowIds: string[]; capImportRowIds: string[] }> {
  const manifest = manifestOf(opts.install);
  const flowRowIds: string[] = [];
  const capImportRowIds: string[] = [];

  for (const flow of manifest.spec.flows) {
    const result = await installFlowPlugin(
      {
        source: pathToFileURL(join(opts.install.installedPath, flow.path)).href,
        version: opts.install.versionLabel.replaceAll("/", "-"),
        projectId: opts.projectId,
        projectSlug: opts.projectSlug,
        flowId: flow.id,
        workspaceRoot: opts.workspaceRoot,
        resolvedRevisionOverride: opts.install.resolvedRevision,
        db: tx,
        signal: opts.signal,
      },
      opts.install.trustStatus,
    );

    flowRowIds.push(result.flowRowId);
  }

  for (const cap of manifest.spec.capabilities) {
    const installed = await installCapabilityRevision({
      source: pathToFileURL(join(opts.install.installedPath, cap.path)).href,
      version: opts.install.versionLabel.replaceAll("/", "-"),
      capabilityRefId: cap.id,
      projectId: opts.projectId,
      resolvedRevisionOverride: opts.install.resolvedRevision,
      db: tx,
      signal: opts.signal,
    });

    capImportRowIds.push(installed.importRowId);
  }

  await writeIngestionRecords(tx, opts.projectId, opts.install);

  if (flowRowIds.length > 0) {
    await tx
      .update(flows)
      .set({ packageInstallId: opts.install.id, updatedAt: new Date() })
      .where(inArray(flows.id, flowRowIds));
  }
  if (capImportRowIds.length > 0) {
    await tx
      .update(capabilityImports)
      .set({ packageInstallId: opts.install.id, updatedAt: new Date() })
      .where(inArray(capabilityImports.id, capImportRowIds));
  }

  return { flowRowIds, capImportRowIds };
}

// Post-commit side-effect: run pending bundle setup.sh per the package trust
// (fetch and execute stay physically separate — ADR-021/042).
async function runPendingCapabilitySetups(
  db: any,
  capImportRowIds: string[],
  trustStatus: string,
  signal?: AbortSignal,
): Promise<void> {
  if (trustStatus === "untrusted" || capImportRowIds.length === 0) return;

  const rows = await db
    .select()
    .from(capabilityImports)
    .where(inArray(capabilityImports.id, capImportRowIds));

  for (const row of rows) {
    if (row.setupStatus === "pending") {
      await runCapabilityRevisionSetup({ importRowId: row.id, db, signal });
    }
  }
}

export type AttachResult = { attachmentId: string };

// One transaction writes the WHOLE group: member flows rows + capability
// imports + MCP/restriction ingestion + the attachment + group FK links.
// Crash windows: install-done/attach-uncommitted → orphan install (GC);
// committed/yaml-not-written → caller's write-back heals on the next
// mutation (see yaml-writeback.ts).
export async function attachPackage(opts: {
  projectId: string;
  projectSlug: string;
  packageInstallId: string;
  workspaceRoot?: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
}): Promise<AttachResult | null> {
  const db = opts.db ?? getDb();
  const [install] = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, opts.packageInstallId));

  if (!install) return null;

  if (install.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `package install ${install.id} is ${install.packageStatus}, not Installed`,
    );
  }

  const manifest = manifestOf(install);
  const flowIds = manifest.spec.flows.map((f) => f.id);

  const attachmentId = await db.transaction(async (tx: any) => {
    // Pre-guard: a manifest flow id colliding with an EXISTING standalone
    // flow of this project would hit flows_project_ref_uq mid-group —
    // refuse deterministically instead (CONFLICT, no partial group).
    const colliding = await tx
      .select({ id: flows.id, flowRefId: flows.flowRefId })
      .from(flows)
      .where(
        and(
          eq(flows.projectId, opts.projectId),
          inArray(flows.flowRefId, flowIds),
        ),
      );

    if (colliding.length > 0) {
      throw new MaisterError(
        "CONFLICT",
        `flow id(s) ${colliding.map((c: any) => `"${c.flowRefId}"`).join(", ")} already exist in this project`,
      );
    }

    const inserted = await tx
      .insert(projectPackageAttachments)
      .values({
        id: randomUUID(),
        projectId: opts.projectId,
        packageInstallId: install.id,
        packageName: install.name,
      })
      .onConflictDoNothing()
      .returning({ id: projectPackageAttachments.id });

    if (inserted.length === 0) {
      throw new MaisterError(
        "CONFLICT",
        `package "${install.name}" is already attached to this project`,
      );
    }

    await wireMembers(tx, {
      projectId: opts.projectId,
      projectSlug: opts.projectSlug,
      workspaceRoot: opts.workspaceRoot,
      install,
      signal: opts.signal,
    });

    return inserted[0].id as string;
  });

  const capRows = await db
    .select({ id: capabilityImports.id })
    .from(capabilityImports)
    .where(
      and(
        eq(capabilityImports.projectId, opts.projectId),
        eq(capabilityImports.packageInstallId, install.id),
      ),
    );

  await runPendingCapabilitySetups(
    db,
    capRows.map((r: any) => r.id),
    install.trustStatus,
    opts.signal,
  );

  log.info(
    { projectId: opts.projectId, packageInstallId: install.id, attachmentId },
    "package attached",
  );

  return { attachmentId };
}

async function loadAttachment(
  db: any,
  projectId: string,
  attachmentId: string,
): Promise<any | null> {
  const [att] = await db
    .select()
    .from(projectPackageAttachments)
    .where(
      and(
        eq(projectPackageAttachments.id, attachmentId),
        eq(projectPackageAttachments.projectId, projectId),
      ),
    );

  return att ?? null;
}

// Detach: refused while any member revision is pinned by an active run; one
// transaction removes the attachment + member rows + ingested records.
// Member flow_revisions stay (in-flight runs + GC own them).
export async function detachPackage(opts: {
  projectId: string;
  attachmentId: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
}): Promise<{ detached: boolean } | null> {
  const db = opts.db ?? getDb();
  const att = await loadAttachment(db, opts.projectId, opts.attachmentId);

  if (!att) return null;

  const [install] = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, att.packageInstallId));

  const memberFlows = await db
    .select({ id: flows.id, enabledRevisionId: flows.enabledRevisionId })
    .from(flows)
    .where(
      and(
        eq(flows.projectId, opts.projectId),
        eq(flows.packageInstallId, att.packageInstallId),
      ),
    );
  const revisionIds = memberFlows
    .map((f: any) => f.enabledRevisionId)
    .filter((id: unknown): id is string => typeof id === "string");

  if (revisionIds.length > 0) {
    const active = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, opts.projectId),
          inArray(runs.flowRevisionId, revisionIds),
          inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );

    if (active.length > 0) {
      throw new MaisterError(
        "PRECONDITION",
        `package "${att.packageName}" has ${active.length} active run(s) pinned to member revisions; finish or abandon them first`,
      );
    }
  }

  await db.transaction(async (tx: any) => {
    if (install) await deleteIngestionRecords(tx, opts.projectId, install);
    await tx
      .delete(capabilityImports)
      .where(
        and(
          eq(capabilityImports.projectId, opts.projectId),
          eq(capabilityImports.packageInstallId, att.packageInstallId),
        ),
      );
    await tx
      .delete(flows)
      .where(
        and(
          eq(flows.projectId, opts.projectId),
          eq(flows.packageInstallId, att.packageInstallId),
        ),
      );
    await tx
      .delete(projectPackageAttachments)
      .where(eq(projectPackageAttachments.id, att.id));
  });

  log.info(
    {
      projectId: opts.projectId,
      attachmentId: att.id,
      package: att.packageName,
    },
    "package detached",
  );

  return { detached: true };
}

// Upgrade: flips the group to another installed revision of the SAME package
// name in one transaction. In-flight runs keep their pinned revisions; flows
// removed from the new manifest lose their enablement rows.
export async function upgradeAttachment(opts: {
  projectId: string;
  projectSlug: string;
  attachmentId: string;
  packageInstallId: string;
  workspaceRoot?: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
}): Promise<{ upgraded: boolean } | null> {
  const db = opts.db ?? getDb();
  const att = await loadAttachment(db, opts.projectId, opts.attachmentId);

  if (!att) return null;

  const [next] = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, opts.packageInstallId));

  if (!next) return null;

  if (next.name !== att.packageName) {
    throw new MaisterError(
      "PRECONDITION",
      `install ${next.id} is package "${next.name}", attachment is "${att.packageName}"`,
    );
  }
  if (next.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `package install ${next.id} is ${next.packageStatus}, not Installed`,
    );
  }

  const [previous] = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, att.packageInstallId));

  await db.transaction(async (tx: any) => {
    if (previous) await deleteIngestionRecords(tx, opts.projectId, previous);

    // Old bundle import rows are replaced by the new revision's; member flow
    // rows are upserted in place by installFlowPlugin (same flowRefId).
    await tx
      .delete(capabilityImports)
      .where(
        and(
          eq(capabilityImports.projectId, opts.projectId),
          eq(capabilityImports.packageInstallId, att.packageInstallId),
        ),
      );

    const { flowRowIds } = await wireMembers(tx, {
      projectId: opts.projectId,
      projectSlug: opts.projectSlug,
      workspaceRoot: opts.workspaceRoot,
      install: next,
      signal: opts.signal,
    });

    // Flows the new manifest no longer ships lose their enablement rows.
    await tx
      .delete(flows)
      .where(
        and(
          eq(flows.projectId, opts.projectId),
          eq(flows.packageInstallId, att.packageInstallId),
          flowRowIds.length > 0 ? notInArray(flows.id, flowRowIds) : undefined,
        ),
      );

    await tx
      .update(projectPackageAttachments)
      .set({ packageInstallId: next.id })
      .where(eq(projectPackageAttachments.id, att.id));
  });

  const capRows = await db
    .select({ id: capabilityImports.id })
    .from(capabilityImports)
    .where(
      and(
        eq(capabilityImports.projectId, opts.projectId),
        eq(capabilityImports.packageInstallId, next.id),
      ),
    );

  await runPendingCapabilitySetups(
    db,
    capRows.map((r: any) => r.id),
    next.trustStatus,
    opts.signal,
  );

  log.info(
    {
      projectId: opts.projectId,
      attachmentId: att.id,
      from: att.packageInstallId,
      to: next.id,
    },
    "package attachment upgraded",
  );

  return { upgraded: true };
}

// One operator decision per package revision: the same transaction fans
// trust onto EVERY member row; pending setups run AFTER the commit.
export async function trustPackageRevision(opts: {
  packageInstallId: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
}): Promise<{ trusted: boolean } | null> {
  const db = opts.db ?? getDb();
  const [install] = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, opts.packageInstallId));

  if (!install) return null;

  const manifest = manifestOf(install);
  const flowIds = manifest.spec.flows.map((f) => f.id);

  await db.transaction(async (tx: any) => {
    await tx
      .update(packageInstalls)
      .set({ trustStatus: "trusted", updatedAt: new Date() })
      .where(eq(packageInstalls.id, install.id));

    if (flowIds.length > 0) {
      await tx
        .update(flowRevisions)
        .set({ execTrust: "trusted" })
        .where(
          and(
            eq(flowRevisions.resolvedRevision, install.resolvedRevision),
            inArray(flowRevisions.flowRefId, flowIds),
          ),
        );
    }

    await tx
      .update(flows)
      .set({ trustStatus: "trusted", updatedAt: new Date() })
      .where(eq(flows.packageInstallId, install.id));

    await tx
      .update(capabilityImports)
      .set({ trustStatus: "trusted", updatedAt: new Date() })
      .where(eq(capabilityImports.packageInstallId, install.id));
  });

  // Post-trust setup (AFTER the tx): member bundles first, then member flow
  // revisions with pending setup.
  const capRows = await db
    .select()
    .from(capabilityImports)
    .where(eq(capabilityImports.packageInstallId, install.id));

  for (const row of capRows) {
    if (row.setupStatus === "pending") {
      await runCapabilityRevisionSetup({
        importRowId: row.id,
        db,
        signal: opts.signal,
      });
    }
  }

  if (flowIds.length > 0) {
    const revRows = await db
      .select()
      .from(flowRevisions)
      .where(
        and(
          eq(flowRevisions.resolvedRevision, install.resolvedRevision),
          inArray(flowRevisions.flowRefId, flowIds),
        ),
      );

    for (const rev of revRows) {
      if (rev.setupStatus === "pending") {
        await runRevisionSetup({
          revisionId: rev.id,
          installedPath: rev.installedPath,
          db,
          signal: opts.signal,
        });
      }
    }
  }

  log.info(
    { packageInstallId: install.id, flows: flowIds.length },
    "package revision trusted (fan-out complete)",
  );

  return { trusted: true };
}
