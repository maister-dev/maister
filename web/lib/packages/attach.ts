import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { MaisterPackageManifest } from "@/lib/config.schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

import { createHash, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import pino from "pino";

import {
  materialConflict,
  publishMaterial,
} from "@/lib/project-dependencies/material";
import { materialLayoutDigest } from "@/lib/project-dependencies/content-digest";
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";
import { parseAgentDefinition, qualifyAgentId } from "@/lib/agents/definition";
import {
  installCapabilityRevision,
  prepareCapabilityRevision,
  bindPreparedCapability,
  type PreparedCapability,
  runCapabilityRevisionSetup,
} from "@/lib/capabilities/import";
import { getDb } from "@/lib/db/client";
import { localDirectoryPath } from "@/lib/runtime-file-url";
import { requireDependencyAdmin } from "@/lib/project-dependencies/claims";
import { lockProjectWriteGrant } from "@/lib/project-action-authority";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  localDirectoryContentDigest,
  installFlowPlugin,
  installRevision,
  repairPackageRootSchemaCache,
  runRevisionSetup,
  type InstallResult,
  type InstalledRevision,
} from "@/lib/flows";
import { loadFlowManifest } from "@/lib/config";
import { isOperationalEvidenceContract } from "@/lib/run-results/contract";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";
import { OPERATIONAL_EVIDENCE_CONTRACT } from "@/lib/agents/kind";
import { requiresExplicitNativeFindingsEnablement } from "@/lib/flows/enablement-states";
import { evaluateMcpReadiness } from "@/lib/mcp/readiness";
import { loadMcpReadinessContext } from "@/lib/mcp/readiness-host";
import { assertPackageMemberPaths } from "@/lib/packages/manifest";
import { resolvePackageSource } from "@/lib/packages/install";
import { redactUrl } from "@/lib/repo-source";
import { assertAttachedQualificationAgentsPolicy } from "@/lib/agents/qualification-policy";
import { readPackageAgentSources } from "@/lib/agents/package-contract";
import { lockPackageRunBlockers } from "@/lib/packages/run-pins";
import {
  assertPackageMemberOwnership,
  lockDependencyProject,
  recordManualPackage,
  manualPackageHead,
  installedPackageCoordinates,
  assertOperatorPin,
  type PackageCoordinates,
  removePackageDeclaration,
  type DependencyTransaction,
} from "@/lib/project-dependencies/package-writes";
import {
  assertCapabilityMemberOwnership,
  retireClearedCapabilityOwners,
  refreshPackageCapabilityTrust,
  refreshAttachedPackageSkills,
  reconcileDependencyCatalog,
} from "@/lib/project-dependencies/catalog";
import {
  finishFlowLinkPublication,
  queueProjectFlowLinks,
  validateProjectFlowLink,
} from "@/lib/project-dependencies/flow-links";
import { prepareDependencyFlow } from "@/lib/project-dependencies/prepare-flow";
import {
  enqueueTrustedSetup,
  finishTrustedSetup,
} from "@/lib/project-dependencies/post-trust-store";
import { requireParentPackageTrust } from "@/lib/project-dependencies/member-trust";
import { settlePreparedPackageSetups } from "@/lib/project-dependencies/stage-setup";
import { withSettledSetups } from "@/lib/project-dependencies/setup";

// FIXME(any): dual drizzle-orm peer-dep variants (see flows.ts).
const {
  packageInstalls,
  projectPackageAttachments,
  flows,
  flowRevisions,
  capabilityImports,
  capabilityRecords,
  runs,
  tasks,
} = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "package-attach",
  level: process.env.LOG_LEVEL ?? "info",
});

// `manifest` jsonb on package_installs: the parsed spec + the content
// inventory (spec stays strict-schema-parseable on its own).
export type PackageInstallManifest = {
  spec: MaisterPackageManifest;
  // `agents` = capability subagents (capability/**/agents, materialized into
  // `.claude/` at run). `platformAgents` = package-root `maister-agents/`
  // platform-agent definitions. Old installs predate `platformAgents` → readers
  // default it to `[]`.
  inventory: {
    skills: string[];
    agents: string[];
    platformAgents: string[];
    skillsByCapability?: Record<string, string[]>;
  };
  // Install coordinate (packages[] `path` subdir) — needed by the
  // reviewed Git export to reproduce the pin.
  sourceSubpath?: string;
  contentWitness?: string;
  layoutDigest?: string;
};

/** Package roots never run setup; their extracted members have separate caches. */
async function verifyPackageBytes(
  directory: string,
  witness: string,
  expectedLayout?: string,
): Promise<void> {
  const actual = await localDirectoryContentDigest(
    directory,
    new Set([".git"]),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") materialConflict();
    throw error;
  });

  if (actual !== witness) materialConflict();
  const layout = await materialLayoutDigest(directory);

  if (expectedLayout && layout !== expectedLayout) materialConflict();
}

export async function verifyCachedPackage(
  install: PackageMaterial,
): Promise<boolean> {
  const witness = manifestOf(install).contentWitness;

  if (witness) {
    await verifyPackageBytes(
      install.installedPath,
      witness,
      manifestOf(install).layoutDigest,
    );

    return true;
  }
  if (localDirectoryPath(install.sourceUrl) === null) return false;
  // A pre-upgrade local package's revision used the whole original directory.
  await materialLayoutDigest(install.installedPath);
  const original = await localDirectoryContentDigest(install.installedPath);

  if (original.slice(0, 40) !== install.resolvedRevision) materialConflict();

  return true;
}

async function verifyPackageMemberSource(
  install: PackageMaterial,
  signal?: AbortSignal,
): Promise<void> {
  assertPackageMemberPaths(manifestOf(install).spec);
  if (await verifyCachedPackage(install)) return;
  const original = await resolvePackageSource({
    source: install.sourceUrl,
    version: install.versionLabel,
    path: manifestOf(install).sourceSubpath,
    signal,
  });

  try {
    if (original.resolvedRevision !== install.resolvedRevision)
      materialConflict();
    await verifyPackageBytes(
      install.installedPath,
      await localDirectoryContentDigest(original.pkgRoot, new Set([".git"])),
      await materialLayoutDigest(original.pkgRoot),
    );
  } finally {
    await original.cleanup();
  }
}

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
  const skillsByCapability = new Map<string, string[]>();
  const agents = new Set<string>();
  const platformAgents = new Set<string>();

  for (const cap of manifest.capabilities) {
    const skillsDir = join(pkgRoot, cap.path, "skills");
    const agentsDir = join(pkgRoot, cap.path, "agents");

    const entries = await readdir(skillsDir, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const provided = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    skillsByCapability.set(cap.id, provided);
    for (const ref of provided) skills.add(ref);
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

  // Platform-agents live at the package root `maister-agents/` — distinct from
  // the capability subagents scanned above (which materialize into `.claude/`
  // at run and are NOT platform-agents).
  try {
    for (const entry of await readdir(join(pkgRoot, "maister-agents"), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        platformAgents.add(entry.name.replace(/\.md$/, ""));
      }
    }
  } catch {
    // package without maister-agents/ — fine
  }

  return {
    skillsByCapability: Object.fromEntries(skillsByCapability),
    skills: [...skills].sort(),
    agents: [...agents].sort(),
    platformAgents: [...platformAgents].sort(),
  };
}

export type InstallPackageRevisionResult = {
  id: string;
  name: string;
  versionLabel: string;
  resolvedRevision: string;
  reused: boolean;
  manifest: PackageInstallManifest;
};

async function projectInstalledMembers(
  id: string,
  name: string,
  db: Db,
): Promise<void> {
  // ADR-106: platform agents ship at the package ROOT (`maister-agents/`) —
  // register them AFTER the member flow installs, keyed by package name.
  // Best-effort: a broken agent file is reported in the summary, never fails
  // the surrounding install (a later resync re-projects the catalog anyway).
  try {
    const { registerPackageAgents, resyncAgents } =
      await import("@/lib/agents/registry");
    const agentSummary = await registerPackageAgents(id, db);

    if (agentSummary.invalid.length > 0) {
      log.warn(
        { id, name, invalid: agentSummary.invalid },
        "package shipped invalid agent definitions",
      );
    }

    // ADR-106: registerPackageAgents wrote THIS install's rows, which may be an
    // OLDER revision than another already-Installed revision of the same package
    // name. Re-assert newest-per-name so a re-install of an older revision can't
    // regress the catalog projection until the next boot/admin resync.
    await resyncAgents(db);
  } catch (err) {
    log.warn(
      { id, name, err: err instanceof Error ? err.message : String(err) },
      "agent registration after package install failed",
    );
  }

  // ADR-143 D6/D7: project every `evaluationMethods[]` entry into
  // `evaluation_method_revisions` (INERT parse/hash, activation stays
  // disabled). Best-effort: an invalid method is projected report-only, never
  // fails the surrounding install.
  try {
    const { registerPackageMethods } =
      await import("@/lib/evaluations/methods-registry");
    const methodSummary = await registerPackageMethods(id, db);

    if (methodSummary.invalid.length > 0) {
      log.warn(
        { id, name, invalid: methodSummary.invalid },
        "package shipped invalid evaluation methods",
      );
    }
  } catch (err) {
    log.warn(
      { id, name, err: err instanceof Error ? err.message : String(err) },
      "evaluation method projection after package install failed",
    );
  }
}

// Platform-scope package install (ADR-088): resolve ONCE, copy the package
// bytes into the content-addressed platform cache, record the immutable
// `package_installs` row two-phase (Installing → Installed), and pre-install
// the member flow revisions GLOBALLY (flow_revisions only — project wiring
// happens at attach). `setup.sh` is NEVER executed here.
export async function installPackageRevision(opts: {
  source: string;
  version: string;
  path?: string;
  trustStatus?: "untrusted" | "trusted" | "trusted_by_policy";
  // M39 Stream B (ADR-107): provenance back-link recorded when a centralized
  // local package is cut, so a project's attached cut can detect a newer cut.
  sourceLocalPackageId?: string;
  sourceCommitSha?: string;
  onResolve?: (revision: string, layoutDigest: string) => Promise<void>;
  authorizePublication?: (tx: Db) => Promise<void>;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
}): Promise<InstallPackageRevisionResult> {
  const database = opts.db ?? getDb();
  const resolved = await resolvePackageSource({
    source: opts.source,
    version: opts.version,
    path: opts.path,
    signal: opts.signal,
  });

  try {
    const name = resolved.manifest.name;

    await opts.onResolve?.(resolved.resolvedRevision, resolved.layoutDigest);

    for (const flow of resolved.manifest.flows) {
      const manifest = await loadFlowManifest(
        join(resolved.pkgRoot, flow.path, "flow.yaml"),
        {
          errorCode: "CONFIG",
          surface: "admin-package-install-member",
        },
      );

      if (
        manifest.result?.export?.native_contract ===
        OPERATIONAL_EVIDENCE_CONTRACT
      ) {
        const contract = await resolveFlowExportContract({
          flowRefId: flow.id,
          manifest,
          revision: {
            id: flow.id,
            resolvedRevision: resolved.resolvedRevision,
            installedPath: resolved.pkgRoot,
          },
        });

        if (!isOperationalEvidenceContract(contract))
          throw new MaisterError(
            "CONFIG",
            "Operational evidence export is unavailable",
          );
      }
    }

    const hashMaterial = (dir: string) =>
      localDirectoryContentDigest(dir, new Set([".git"]));
    const witness = await hashMaterial(resolved.pkgRoot);
    const layoutDigest = resolved.layoutDigest;
    const cachePath = packageCachePath(name, resolved.resolvedRevision);
    const installed = await database.transaction(async (db: Db) => {
      const beforePublish = () => opts.authorizePublication?.(db);

      await beforePublish();
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${cachePath}, 0))`,
      );
      const physicalOwners = await db
        .select()
        .from(packageInstalls)
        .where(eq(packageInstalls.installedPath, cachePath));

      for (const owner of physicalOwners) {
        const prior = manifestOf(owner);

        if (
          owner.resolvedRevision !== resolved.resolvedRevision ||
          (prior.layoutDigest && prior.layoutDigest !== layoutDigest) ||
          (prior.contentWitness && prior.contentWitness !== witness)
        )
          materialConflict();
        if (
          !prior.contentWitness &&
          (prior.sourceSubpath !== opts.path ||
            owner.sourceUrl !== opts.source) &&
          (await hashMaterial(cachePath)) !== witness
        )
          materialConflict();
      }
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
        const existingManifest = manifestOf(existing);
        const resolvedSchemaDir = join(resolved.pkgRoot, "schemas");

        // Repair shared schemas from the resolved source, then verify the entire
        // package before any member is read from the installed directory.
        await beforePublish();
        await repairPackageRootSchemaCache({
          sourceSchemaDir: resolvedSchemaDir,
          cachedSchemaDir: join(existing.installedPath, "schemas"),
        });
        await verifyPackageBytes(existing.installedPath, witness, layoutDigest);
        await publishMaterial({
          beforePublish,
          revision: resolved.resolvedRevision,
          source: resolved.pkgRoot,
          target: cachePath,
          digest: witness,
          layoutDigest,
          hash: hashMaterial,
          hasHistoricalOwner: async () => true,
        });
        const inventory = existingManifest.inventory?.skillsByCapability
          ? existingManifest.inventory
          : await collectInventory(resolved.pkgRoot, resolved.manifest);

        if (
          !existingManifest.layoutDigest ||
          !existingManifest.contentWitness ||
          inventory !== existingManifest.inventory
        ) {
          await db
            .update(packageInstalls)
            .set({
              manifest: {
                ...existingManifest,
                inventory,
                contentWitness: witness,
                layoutDigest,
              },
            })
            .where(eq(packageInstalls.id, existing.id));
          if (inventory !== existingManifest.inventory)
            await refreshAttachedPackageSkills(db, existing.id);
        }
        for (const flow of existingManifest.spec.flows) {
          await installRevision({
            source: join(existing.installedPath, flow.path),
            version: existing.versionLabel.replaceAll("/", "-"),
            flowId: flow.id,
            resolvedRevisionOverride: existing.resolvedRevision,
            sharedSchemaDir: resolvedSchemaDir,
            resultProfiles: existingManifest.spec.result_profiles,
            db,
            signal: opts.signal,
            authorizePublication: opts.authorizePublication,
          });
        }
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
          manifest: {
            ...existingManifest,
            inventory,
            contentWitness: witness,
            layoutDigest,
          },
        };
      }

      const id = existing?.id ?? randomUUID();
      // The "local" sentinel resolves to the content-digest label so local
      // versions are self-identifying (ADR-088: local-<digest12>).
      const versionLabel =
        opts.version === "local"
          ? `local-${resolved.resolvedRevision.slice(0, 12)}`
          : opts.version;

      const inventory = await collectInventory(
        resolved.pkgRoot,
        resolved.manifest,
      );
      const manifestJson: PackageInstallManifest = {
        spec: resolved.manifest,
        inventory,
        contentWitness: witness,
        layoutDigest,
        ...(opts.path !== undefined ? { sourceSubpath: opts.path } : {}),
      };
      const manifestDigest = createHash("sha256")
        .update(JSON.stringify(resolved.manifest))
        .digest("hex");

      if (!existing) {
        await db.insert(packageInstalls).values({
          id,
          sourceUrl: opts.source,
          name,
          versionLabel,
          resolvedRevision: resolved.resolvedRevision,
          manifest: manifestJson,
          manifestDigest,
          installedPath: cachePath,
          packageStatus: "Installing",
          trustStatus: opts.trustStatus ?? "untrusted",
          sourceLocalPackageId: opts.sourceLocalPackageId ?? null,
          sourceCommitSha: opts.sourceCommitSha ?? null,
        });
      } else {
        await db
          .update(packageInstalls)
          .set({ packageStatus: "Installing", updatedAt: new Date() })
          .where(eq(packageInstalls.id, id));
      }

      await publishMaterial({
        beforePublish,
        revision: resolved.resolvedRevision,
        source: resolved.pkgRoot,
        target: cachePath,
        digest: witness,
        layoutDigest,
        hash: hashMaterial,
      });

      // Pre-install member flow revisions (global, immutable, shared cache) so
      // per-project attach only wires enablement rows.
      for (const flow of resolved.manifest.flows) {
        await installRevision({
          source: join(cachePath, flow.path),
          version: resolved.versionLabel,
          flowId: flow.id,
          resolvedRevisionOverride: resolved.resolvedRevision,
          sharedSchemaDir: join(cachePath, "schemas"),
          resultProfiles: resolved.manifest.result_profiles,
          db,
          signal: opts.signal,
          authorizePublication: opts.authorizePublication,
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
        versionLabel,
        resolvedRevision: resolved.resolvedRevision,
        reused: false,
        manifest: manifestJson,
      };
    });

    if (!installed.reused) {
      if (opts.authorizePublication) {
        const authorize = opts.authorizePublication;

        await database.transaction(async (tx: Db) => {
          await authorize(tx);
          await projectInstalledMembers(installed.id, name, tx);
        });
      } else await projectInstalledMembers(installed.id, name, database);
    }

    return installed;
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

async function storeVerifiedInventory(
  db: Db,
  installId: string,
  inventory: PackageInstallManifest["inventory"],
): Promise<void> {
  await db
    .update(schemaModule.packageInstalls)
    .set({
      manifest: sql`jsonb_set(manifest,'{inventory}',${JSON.stringify(inventory)}::jsonb)`,
    })
    .where(eq(schemaModule.packageInstalls.id, installId));
}

function isReadyFlowRevision(revision: {
  packageStatus: string;
  setupStatus: string;
}): boolean {
  return (
    revision.packageStatus === "Installed" &&
    (revision.setupStatus === "not_required" || revision.setupStatus === "done")
  );
}

// Records ingested on attach carry this origin so the config SET/CLEAR sweep
// never disables them — attach/detach own their lifecycle (ADR-088).
const ATTACHMENT_ORIGIN = "package-attachment";

// ADR-179 (D18): ONE chunked host read over the UNION of every template's
// referenced names, issued BEFORE the transaction. Reads, not side effects: a
// host failure yields `Unknown` for every row and the attach still commits.
async function packageReadinessByRef(install: any): Promise<ReadinessByRef> {
  const manifest = manifestOf(install);
  // The stored spec was normalized at install (`normalizePackageManifest`), so
  // `env` is the slot map even though the schema type still admits `string[]`.
  const templates = manifest.spec.mcps.map(
    (mcp) =>
      mcp as {
        id: string;
        env?: Record<string, string>;
        headers?: Record<string, string>;
        bearerTokenEnv?: string | null;
        transport?: "stdio" | "http";
        command?: string;
        url?: string;
      },
  );

  if (templates.length === 0) return new Map();

  const context = await loadMcpReadinessContext(templates, {
    packageInstallId: install.id,
  });

  return new Map(
    templates.map((mcp) => {
      const readiness = evaluateMcpReadiness(
        {
          transport: mcp.transport ?? "stdio",
          command: mcp.command ?? null,
          url: mcp.url ?? null,
          env: mcp.env,
          headers: mcp.headers,
          bearerTokenEnv: mcp.bearerTokenEnv ?? null,
        },
        context,
      );

      return [
        mcp.id,
        { status: readiness.status, reasons: readiness.reasons },
      ] as const;
    }),
  );
}

function ingestionRecords(
  manifest: PackageInstallManifest,
  install: any,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];

  for (const mcp of manifest.spec.mcps) {
    // ADR-179 (D34): `env` is ALREADY a map here — the loader folded the legacy
    // `env:NAME` list once, so both manifest forms produce identical material.
    const env = { ...(mcp.env ?? {}) };

    // ADR-129 (D3): an entry with NO implementation is a REQUIREMENT, not a
    // template. It is marked `requirement: true` so materialization skips it (it
    // declares a needed ref; the project satisfies it via a binding). The
    // requirements ledger reads these markers. A template keeps its impl.
    const isRequirement =
      mcp.command === undefined &&
      mcp.url === undefined &&
      mcp.transport === undefined;

    records.push({
      capabilityRefId: mcp.id,
      kind: "mcp",
      label: mcp.description ?? mcp.id,
      material: isRequirement
        ? {
            origin: ATTACHMENT_ORIGIN,
            packageInstallId: install.id,
            requirement: true,
            // A requirement declares SLOTS: the map keys. Since ADR-179 that is
            // also what `resolveBindTarget` reads, so an overlay against a
            // requirement or a package TEMPLATE can finally name them.
            env,
            headers: {},
            recommendedPlatformServerId: mcp.recommendedPlatformServerId,
          }
        : {
            origin: ATTACHMENT_ORIGIN,
            packageInstallId: install.id,
            transport: mcp.transport,
            command: mcp.command,
            args: mcp.args ?? [],
            env,
            url: mcp.url,
            // Rebuilt wholesale per ingestion, so a version that DROPS these
            // leaves no stale entry behind (SET/CLEAR symmetry).
            headers: { ...(mcp.headers ?? {}) },
            bearerTokenEnv: mcp.bearerTokenEnv ?? null,
            recommendedPlatformServerId: mcp.recommendedPlatformServerId,
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

  for (const skill of manifest.inventory.skills) {
    records.push({
      capabilityRefId: skill,
      kind: "skill",
      label: skill,
      material: {
        origin: ATTACHMENT_ORIGIN,
        packageInstallId: install.id,
        hasContent: true,
      },
    });
  }

  return records;
}

// ADR-179 (D18): the third write-time readiness cache site. The verdict arrives
// PRECOMPUTED, keyed by ref — the two host reads happen in the public entry
// points BEFORE `db.transaction`, so this function stays inside the tx without
// doing I/O of its own.
export type ReadinessByRef = ReadonlyMap<
  string,
  { status: "Unknown" | "Ready" | "NotReady"; reasons: string[] }
>;

async function writeIngestionRecords(
  tx: any,
  projectId: string,
  install: any,
  readinessByRef: ReadinessByRef = new Map(),
): Promise<number> {
  const manifest = manifestOf(install);
  const records = ingestionRecords(manifest, install).map((record) => {
    const readiness = readinessByRef.get(record.capabilityRefId as string);

    return readiness && record.kind === "mcp"
      ? {
          ...record,
          material: { ...(record.material as object), readiness },
        }
      : record;
  });

  if (records.length === 0) return 0;

  // The upsert below targets (projectId, source, kind, capabilityRefId) —
  // a same-(kind, id) record owned by ANOTHER attached package would be
  // silently overwritten. Refuse instead; same-id-different-kind coexists.
  const existing = await tx
    .select({
      capabilityRefId: capabilityRecords.capabilityRefId,
      kind: capabilityRecords.kind,
      material: capabilityRecords.material,
    })
    .from(capabilityRecords)
    .where(
      and(
        eq(capabilityRecords.projectId, projectId),
        eq(capabilityRecords.source, "flow-package"),
        inArray(
          capabilityRecords.capabilityRefId,
          records.map((r) => r.capabilityRefId as string),
        ),
      ),
    );
  const foreign = existing.filter(
    (row: any) =>
      records.some(
        (r) => r.kind === row.kind && r.capabilityRefId === row.capabilityRefId,
      ) && row.material?.packageInstallId !== install.id,
  );

  if (foreign.length > 0) {
    const ids = [
      ...new Set(foreign.map((row: any) => `"${row.capabilityRefId}"`)),
    ].join(", ");

    throw new MaisterError(
      "CONFLICT",
      `package "${install.name}" ships capability id(s) ${ids} already provided by another attached package`,
    );
  }

  const usable =
    install.packageStatus === "Installed" &&
    ["trusted", "trusted_by_policy"].includes(install.trustStatus);

  for (const record of records) {
    // The attachment and its native members must exist before a skill can be
    // derived from project_ready_capability_imports, later in this transaction.
    const selectable = usable && record.kind !== "skill";
    const eligibility = {
      selectable,
      disabledAt: selectable ? null : new Date(),
    };

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
        ...eligibility,
        material: record.material,
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
          ...eligibility,
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
    ...manifest.inventory.skills,
  ];

  if (refIds.length === 0) return;

  await tx.delete(capabilityRecords).where(
    and(
      eq(capabilityRecords.projectId, projectId),
      eq(capabilityRecords.source, "flow-package"),
      inArray(capabilityRecords.capabilityRefId, refIds),
      // Only rows THIS install wrote — a same-id record owned by another
      // attached package must survive this package's detach/upgrade.
      sql`${capabilityRecords.material} ->> 'packageInstallId' = ${install.id}`,
    ),
  );
}

type PackageMaterial = typeof schemaModule.packageInstalls.$inferSelect;
export type PreparedMembers = {
  flows: ReadonlyMap<string, InstalledRevision>;
  capabilities: ReadonlyMap<string, PreparedCapability>;
};

function memberCoordinate(install: PackageMaterial, memberPath: string) {
  return {
    source: pathToFileURL(join(install.installedPath, memberPath)).href,
    version: install.versionLabel.replaceAll("/", "-"),
    resolvedRevisionOverride: install.resolvedRevision,
  };
}

/** Stage immutable members before taking the project's effective-state lock. */
export async function preparePackageMembers(
  db: Db,
  projectId: string,
  install: PackageMaterial,
  roleRefs: readonly string[] | undefined,
  signal: AbortSignal | undefined,
  authorizePublication: (tx: Db) => Promise<void>,
): Promise<PreparedMembers> {
  const spec = manifestOf(install).spec;

  await verifyPackageMemberSource(install, signal);
  if (!manifestOf(install).inventory?.skillsByCapability) {
    const inventory = await collectInventory(install.installedPath, spec);

    await db.transaction(async (tx: Db) => {
      await authorizePublication(tx);
      await storeVerifiedInventory(tx, install.id, inventory);
      await refreshAttachedPackageSkills(tx, install.id);
    });
  }
  const flows = new Map<string, InstalledRevision>();
  const capabilities = new Map<string, PreparedCapability>();

  for (const flow of spec.flows) {
    flows.set(
      flow.id,
      await installRevision({
        ...memberCoordinate(install, flow.path),
        flowId: flow.id,
        roleRefs,
        sharedSchemaDir: join(install.installedPath, "schemas"),
        resultProfiles: spec.result_profiles,
        db,
        signal,
        authorizePublication,
      }),
    );
  }
  for (const cap of spec.capabilities) {
    capabilities.set(
      cap.id,
      await prepareCapabilityRevision({
        ...memberCoordinate(install, cap.path),
        capabilityRefId: cap.id,
        projectId,
        db,
        signal,
        authorizePublication,
      }),
    );
  }

  return { flows, capabilities };
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
    roleRefs?: readonly string[];
    install: any;
    readinessByRef?: ReadinessByRef;
    preparedMembers?: PreparedMembers;
    signal?: AbortSignal;
  },
  projectLink?: typeof validateProjectFlowLink,
): Promise<{ memberFlows: InstallResult[]; capImportRowIds: string[] }> {
  const manifest = manifestOf(opts.install);
  const memberFlows: InstallResult[] = [];
  const capImportRowIds: string[] = [];

  await retireClearedCapabilityOwners(
    tx,
    opts.projectId,
    manifest.spec.capabilities.map((cap) => cap.id),
  );

  // Package members can consume capabilities contributed by this or another
  // package. Their complete registry exists only at launch, after projection.
  for (const flow of manifest.spec.flows) {
    const result = await installFlowPlugin(
      {
        ...memberCoordinate(opts.install, flow.path),
        preparedRevision: opts.preparedMembers?.flows.get(flow.id),
        projectId: opts.projectId,
        projectSlug: opts.projectSlug,
        flowId: flow.id,
        workspaceRoot: opts.workspaceRoot,
        projectLink: projectLink ?? validateProjectFlowLink,
        roleRefs: opts.roleRefs,

        sharedSchemaDir: join(opts.install.installedPath, "schemas"),
        resultProfiles: manifest.spec.result_profiles,
        db: tx,
        signal: opts.signal,
      },
      opts.install.trustStatus,
    );

    await prepareDependencyFlow(tx, opts.projectId, result);
    memberFlows.push(result);
  }

  for (const cap of manifest.spec.capabilities) {
    const args = {
      ...memberCoordinate(opts.install, cap.path),
      capabilityRefId: cap.id,
      trustStatusOverride: opts.install.trustStatus,
      projectId: opts.projectId,
      db: tx,
      signal: opts.signal,
    };
    const prepared = opts.preparedMembers?.capabilities.get(cap.id);
    const installed = prepared
      ? await bindPreparedCapability(args, prepared)
      : await installCapabilityRevision(args);

    capImportRowIds.push(installed.importRowId);
  }

  await writeIngestionRecords(
    tx,
    opts.projectId,
    opts.install,
    opts.readinessByRef,
  );

  const flowRowIds = memberFlows.map((m) => m.flowRowId);

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

  return { memberFlows, capImportRowIds };
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
      const outcome = await runCapabilityRevisionSetup({
        importRowId: row.id,
        db,
        signal,
      });

      if (outcome.setupStatus === "failed")
        throw new MaisterError(
          "FLOW_INSTALL",
          "Package capability setup failed",
          {
            details: { reason: "setup_failed", memberRef: row.capabilityRefId },
          },
        );
    }
  }
}

export type AttachResult = {
  attachmentId: string;
  memberFlows: InstallResult[];
};

// One transaction writes the WHOLE group: member flows rows + capability
// imports + MCP/restriction ingestion + the attachment + group FK links.
// The project link is reconciled from committed state. Reviewed Git export
// reads the declaration independently of the effective attachment.
type PackageActorGrant = {
  userId: string;
  action: "managePackages" | "manageLocalPackages";
};

async function requirePackageGrant(
  tx: Db,
  projectId: string,
  grant?: PackageActorGrant,
): Promise<void> {
  if (
    grant &&
    !(await lockProjectWriteGrant(tx, projectId, grant.userId, [grant.action]))
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current package management permission is required.",
      {
        details: { reason: "authority_revoked" },
      },
    );
}

export type LaunchAttachmentFence = {
  installId: string;
  declaration: { id: string; generation: number };
};

export type PackageAdoption = {
  attachmentId: string;
  priorInstallId: string;
  priorPin: PackageCoordinates;
  applied: LaunchAttachmentFence;
};

function staleLaunchAdoption(): never {
  throw new MaisterError(
    "CONFLICT",
    "The package attachment or its desired pin changed during launch.",
    {
      details: { reason: "stale_generation" },
    },
  );
}

type LaunchHead = Pick<
  typeof schemaModule.projectDependencyDeclarations.$inferSelect,
  "id" | "generation" | "effectiveGeneration"
>;

async function assertLaunchPackageTarget(
  tx: Db,
  currentInstallId: string | undefined,
  head: LaunchHead | undefined,
  expected: LaunchAttachmentFence,
): Promise<void> {
  if (
    !head ||
    currentInstallId !== expected.installId ||
    head.id !== expected.declaration.id ||
    head.generation !== expected.declaration.generation
  )
    staleLaunchAdoption();
  const attempts = schemaModule.projectDependencyAttempts;
  const [attempt] = await tx
    .select({ status: attempts.status })
    .from(attempts)
    .where(
      and(
        eq(attempts.declarationId, head.id),
        eq(attempts.generation, head.generation),
      ),
    )
    .orderBy(desc(attempts.attemptNo))
    .limit(1);

  if (
    head.effectiveGeneration !== head.generation ||
    (attempt && attempt.status !== "succeeded")
  )
    throw new MaisterError(
      "CONFLICT",
      "Resolve the pending project package pin before adopting another shared version.",
      { details: { reason: "dependency_pin_unsettled" } },
    );
}

/** Check every shared adoption before the launcher mints a cut or applies another choice. */
export function captureLaunchPackageFence(
  db: Db,
  projectId: string,
  attachmentId: string,
  installId: string,
): Promise<LaunchAttachmentFence> {
  return db.transaction(async (tx) => {
    await lockDependencyProject(tx, projectId);
    const declarations = schemaModule.projectDependencyDeclarations;
    const attachments = schemaModule.projectPackageAttachments;
    const [row] = await tx
      .select({ head: declarations, installId: attachments.packageInstallId })
      .from(attachments)
      .innerJoin(
        declarations,
        eq(declarations.effectiveAttachmentId, attachments.id),
      )
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.projectId, projectId),
        ),
      );

    if (!row) staleLaunchAdoption();
    const expected = {
      installId,
      declaration: { id: row.head.id, generation: row.head.generation },
    };

    await assertLaunchPackageTarget(tx, row.installId, row.head, expected);

    return expected;
  });
}

type AttachPackageOptions = {
  launchFence?: LaunchAttachmentFence;
  actorGrant?: PackageActorGrant;
  preparedMembers?: PreparedMembers;
  projectId: string;
  projectSlug: string;
  packageInstallId: string;
  workspaceRoot?: string;
  roleRefs?: readonly string[];
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
};

type RecordAttachment = (
  tx: DependencyTransaction,
  attachmentId: string,
  install: Parameters<typeof recordManualPackage>[3],
) => Promise<void>;

/** Capture the available attachment and the declaration that this manual command
 * would adopt. Recheck both before each physical dispatch and final publication. */
export async function prepareManualPackageMutation(
  db: Db,
  opts: AttachPackageOptions & { attachmentId?: string },
  requestedPin?: PackageCoordinates,
) {
  const [install] = await db
    .select()
    .from(schemaModule.packageInstalls)
    .where(eq(schemaModule.packageInstalls.id, opts.packageInstallId));

  if (!install) return null;
  if (install.packageStatus !== "Installed")
    throw new MaisterError(
      "PRECONDITION",
      `package install ${install.id} is ${install.packageStatus}, not Installed`,
    );
  const spec = manifestOf(install).spec;
  const coordinates =
    requestedPin ??
    installedPackageCoordinates({ ...install, manifest: manifestOf(install) });
  const read = async (tx: Db) => {
    await lockDependencyProject(tx, opts.projectId);
    await requirePackageGrant(tx, opts.projectId, opts.actorGrant);
    const [attachment] = await tx
      .select()
      .from(schemaModule.projectPackageAttachments)
      .where(
        and(
          eq(schemaModule.projectPackageAttachments.projectId, opts.projectId),
          opts.attachmentId
            ? eq(schemaModule.projectPackageAttachments.id, opts.attachmentId)
            : eq(
                schemaModule.projectPackageAttachments.packageName,
                install.name,
              ),
        ),
      );

    if (attachment && attachment.packageName !== install.name)
      throw new MaisterError(
        "PRECONDITION",
        `install ${install.id} is package "${install.name}", attachment is "${attachment.packageName}"`,
      );
    if (attachment && !opts.attachmentId)
      throw new MaisterError(
        "CONFLICT",
        `package name "${install.name}" is already attached to this project — rename the fork to attach it beside the upstream`,
        {
          details: { reason: "package_name_taken", packageName: install.name },
        },
      );
    const head = await manualPackageHead(
      tx,
      opts.projectId,
      attachment?.id ?? null,
      install.name,
      coordinates,
    );

    if (opts.launchFence)
      await assertLaunchPackageTarget(
        tx,
        attachment?.packageInstallId,
        head,
        opts.launchFence,
      );
    if (requestedPin) assertOperatorPin(head?.desired, requestedPin);

    return { attachment, head };
  };
  const expected = await db.transaction(read);

  if (opts.attachmentId && !expected.attachment) return null;
  const assertCurrent = async (tx: Db) => {
    const { attachment, head } = await read(tx);

    if (
      head?.id !== expected.head?.id ||
      head?.generation !== expected.head?.generation ||
      attachment?.id !== expected.attachment?.id ||
      attachment?.packageInstallId !== expected.attachment?.packageInstallId
    )
      throw new MaisterError(
        "CONFLICT",
        "The package declaration or attachment changed during material preparation.",
        { details: { reason: "stale_generation" } },
      );
    await assertPackageMemberOwnership(
      tx,
      opts.projectId,
      spec.flows.map((flow) => flow.id),
      attachment?.packageInstallId,
    );
    await assertCapabilityMemberOwnership(
      tx,
      opts.projectId,
      spec.capabilities.map((cap) => cap.id),
      install.resolvedRevision,
      attachment?.packageInstallId,
    );

    return head;
  };
  const members = await preparePackageMembers(
    db,
    opts.projectId,
    install,
    opts.roleRefs,
    opts.signal,
    async (tx) => {
      await assertCurrent(tx);
    },
  );

  if (install.trustStatus !== "untrusted")
    await settlePreparedPackageSetups(
      db,
      members,
      async (tx) => {
        await assertCurrent(tx);
        await requireParentPackageTrust(tx, install.id);
      },
      opts.signal,
    );

  return { members, assertCurrent };
}

async function applyManualPackageMutation<T>(
  opts: AttachPackageOptions & { attachmentId?: string },
  mutate: (
    tx: DependencyTransaction,
    members: PreparedMembers,
    operationId: string,
  ) => Promise<T>,
  onCommitted?: (result: NonNullable<T>) => void,
): Promise<T | null> {
  const db: ReturnType<typeof getDb> = opts.db ?? getDb();
  const staged = await prepareManualPackageMutation(db, opts);

  if (!staged) return null;
  const operationId = randomUUID();
  const result = await withSettledSetups(() =>
    db.transaction(async (tx) => {
      await staged.assertCurrent(tx);
      const result = await mutate(tx, staged.members, operationId);

      if (result) await reconcileDependencyCatalog(tx, opts.projectId);

      return result;
    }),
  );

  if (result) {
    onCommitted?.(result);
    const attachmentId =
      typeof result === "object" &&
      "attachmentId" in result &&
      typeof result.attachmentId === "string"
        ? result.attachmentId
        : opts.attachmentId;
    await finishFlowLinkPublication(db, operationId, attachmentId);
  }

  return result;
}

export function attachPackage(
  opts: AttachPackageOptions,
): Promise<AttachResult | null> {
  return applyManualPackageMutation(
    opts,
    (tx, preparedMembers, linkOperationId) =>
      workerAttachPackage(
        { ...opts, db: tx, preparedMembers, linkOperationId },
        (connection, id, install) =>
          recordManualPackage(connection, opts.projectId, id, install),
      ),
  );
}

export async function workerAttachPackage(
  opts: AttachPackageOptions & { linkOperationId: string },
  recordActual: RecordAttachment,
): Promise<AttachResult | null> {
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
  // Host READS, before the transaction (ADR-179 D18).
  const readinessByRef = await packageReadinessByRef(install);

  const attached: AttachResult = await db.transaction(async (tx: Tx) => {
    const repoPath = await lockDependencyProject(tx, opts.projectId);
    // Name pre-guard (ADR-132 §c): a fork's cut shares its upstream's
    // package name, so (projectId, packageName) would collide — and a whole-
    // package fork also collides on flow ids, so the flow guard below would
    // otherwise mask the real problem. Refuse with the rename path first.
    // The unique constraint stays authoritative for races.
    const [nameHolder] = await tx
      .select({
        packageInstallId: projectPackageAttachments.packageInstallId,
      })
      .from(projectPackageAttachments)
      .where(
        and(
          eq(projectPackageAttachments.projectId, opts.projectId),
          eq(projectPackageAttachments.packageName, install.name),
        ),
      );

    if (nameHolder && nameHolder.packageInstallId !== install.id) {
      throw new MaisterError(
        "CONFLICT",
        `package name "${install.name}" is already attached to this project from another install — rename the fork (manifest name) and cut again to attach it beside the upstream`,
        {
          details: {
            reason: "package_name_taken",
            packageName: install.name,
          },
        },
      );
    }

    await assertPackageMemberOwnership(tx, opts.projectId, flowIds);
    await assertCapabilityMemberOwnership(
      tx,
      opts.projectId,
      manifest.spec.capabilities.map((member) => member.id),
      install.resolvedRevision,
    );

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

    await recordActual(tx, inserted[0].id, install);
    const wired = await wireMembers(tx, {
      projectId: opts.projectId,
      projectSlug: opts.projectSlug,
      workspaceRoot: opts.workspaceRoot ?? repoPath,
      roleRefs: opts.roleRefs,
      install,
      readinessByRef,
      preparedMembers: opts.preparedMembers,
      signal: opts.signal,
    });

    await queueProjectFlowLinks(
      tx,
      opts.linkOperationId,
      opts.projectId,
      opts.workspaceRoot ?? repoPath,
      flowIds,
    );

    return {
      attachmentId: inserted[0].id as string,
      memberFlows: wired.memberFlows,
    };
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
    {
      projectId: opts.projectId,
      packageInstallId: install.id,
      attachmentId: attached.attachmentId,
    },
    "package attached",
  );

  return attached;
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

// FIXME(any): the same dual Drizzle peer-dependency seam as attachPackage.
async function lockAttachment(
  tx: any,
  attachmentId: string,
  installId: string,
): Promise<void> {
  const [current] = await tx
    .select({ packageInstallId: projectPackageAttachments.packageInstallId })
    .from(projectPackageAttachments)
    .where(eq(projectPackageAttachments.id, attachmentId))
    .for("update");

  if (!current || current.packageInstallId !== installId)
    throw new MaisterError(
      "CONFLICT",
      "package attachment changed; reload before retrying",
      {
        details: { reason: "package_attachment_changed", attachmentId },
      },
    );
}

// FIXME(any): the same dual Drizzle peer-dependency seam as attachPackage.
async function deleteMemberEnablements(
  tx: any,
  flowIds: string[],
): Promise<void> {
  if (flowIds.length === 0) return;
  const legacyRuns: { id: string }[] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        inArray(runs.flowId, flowIds),
        isNull(runs.flowRevisionId),
        notInArray(runs.status, ["Done", "Failed", "Abandoned"]),
      ),
    )
    .for("update");

  if (legacyRuns.length > 0)
    throw new MaisterError(
      "PRECONDITION",
      `legacy run(s) ${legacyRuns.map(({ id }) => id).join(", ")} still require the member Flow manifest; finish or abandon them before removing enablement`,
      {
        details: {
          reason: "historical_revision_missing",
          runIds: legacyRuns.map(({ id }) => id),
        },
      },
    );
  // runs.flow_id cascades; tasks.flow_id restricts. These are mutable launch
  // associations, distinct from the retained immutable run revision and evidence.
  await tx
    .update(runs)
    .set({ flowId: null })
    .where(inArray(runs.flowId, flowIds));
  await tx
    .update(tasks)
    .set({ flowId: null })
    .where(inArray(tasks.flowId, flowIds));
  await tx.delete(flows).where(inArray(flows.id, flowIds));
}

// Detach: refused while a member still needs its attachment; one
// transaction removes the attachment + member rows + ingested records.
// Member flow_revisions stay (in-flight runs + GC own them).
export async function detachPackage(opts: {
  actorUserId?: string;
  projectId: string;
  attachmentId: string;
  workspaceRoot?: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
}): Promise<{ detached: boolean } | null> {
  const db = opts.db ?? getDb();
  const operationId = randomUUID();
  const att = await loadAttachment(db, opts.projectId, opts.attachmentId);

  if (!att) return null;

  const [install] = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, att.packageInstallId));

  await db.transaction(async (tx: Tx) => {
    const repoPath = await lockDependencyProject(tx, opts.projectId);

    if (opts.actorUserId)
      await requirePackageGrant(tx, opts.projectId, {
        userId: opts.actorUserId,
        action: "managePackages",
      });
    await lockAttachment(tx, att.id, att.packageInstallId);
    const memberFlows = await tx
      .select({
        id: flows.id,
        flowRefId: flows.flowRefId,
        enabledRevisionId: flows.enabledRevisionId,
      })
      .from(flows)
      .where(
        and(
          eq(flows.projectId, opts.projectId),
          eq(flows.packageInstallId, att.packageInstallId),
        ),
      )
      .for("update");
    const flowIds: string[] = memberFlows.map(
      (flow: { id: string }) => flow.id,
    );
    const revisionIds: string[] = memberFlows
      .map(
        (flow: { enabledRevisionId: string | null }) => flow.enabledRevisionId,
      )
      .filter((id: string | null): id is string => id !== null);
    const blockers = await lockPackageRunBlockers(
      tx,
      opts.projectId,
      flowIds,
      revisionIds,
    );

    if (blockers.length > 0) {
      log.warn(
        { projectId: opts.projectId, attachmentId: att.id, blockers },
        "[FIX:package-run-pins] package detach blocked",
      );
      throw new MaisterError(
        "PRECONDITION",
        `package "${att.packageName}" is pinned by ${blockers.map((blocker) => `${blocker.runId} (${blocker.status}: ${blocker.reasons.join(", ")})`).join("; ")}; stop live execution, finish archival or resolve recovery before detaching`,
        { details: { reason: "package_run_pinned", blockers } },
      );
    }
    await removePackageDeclaration(tx, att.id);
    if (install) await deleteIngestionRecords(tx, opts.projectId, install);
    await tx
      .delete(capabilityImports)
      .where(
        and(
          eq(capabilityImports.projectId, opts.projectId),
          eq(capabilityImports.packageInstallId, att.packageInstallId),
        ),
      );
    await queueProjectFlowLinks(
      tx,
      operationId,
      opts.projectId,
      repoPath,
      memberFlows.map((f: { flowRefId: string }) => f.flowRefId),
    );
    await deleteMemberEnablements(tx, flowIds);
    await tx
      .delete(projectPackageAttachments)
      .where(eq(projectPackageAttachments.id, att.id));
    await reconcileDependencyCatalog(tx, opts.projectId);
  });

  await finishFlowLinkPublication(db, operationId, att.id);
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
type UpgradeAttachmentOptions = {
  actorGrant?: PackageActorGrant;
  preparedMembers?: PreparedMembers;
  roleRefs?: readonly string[];
  projectId: string;
  projectSlug: string;
  attachmentId: string;
  packageInstallId: string;
  workspaceRoot?: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
};

export function upgradeAttachment(
  opts: UpgradeAttachmentOptions,
): Promise<{ upgraded: boolean } | null> {
  return applyManualPackageMutation(
    opts,
    (tx, preparedMembers, linkOperationId) =>
      workerUpgradeAttachment(
        { ...opts, db: tx, preparedMembers, linkOperationId },
        (tx, attachmentId, install) =>
          recordManualPackage(tx, opts.projectId, attachmentId, install),
      ),
  );
}

/** Apply the launch's shared pin only while its source attachment is current.
 * The transaction captures the original alias and the exact generation it wrote. */
export async function changeLaunchPackage(
  opts: UpgradeAttachmentOptions & {
    onCommitted?: (receipt: PackageAdoption) => void;
  },
  expected: LaunchAttachmentFence,
  restorePin?: PackageCoordinates,
): Promise<PackageAdoption> {
  const receipt = await applyManualPackageMutation(
    { ...opts, launchFence: expected },
    async (tx, preparedMembers, linkOperationId) => {
      const declarations = schemaModule.projectDependencyDeclarations;
      const [prior] = await tx
        .select()
        .from(declarations)
        .where(eq(declarations.effectiveAttachmentId, opts.attachmentId));

      if (!prior) staleLaunchAdoption();
      const changed = await workerUpgradeAttachment(
        { ...opts, db: tx, preparedMembers, linkOperationId },
        async (connection, id, install) => {
          await recordManualPackage(
            connection,
            opts.projectId,
            id,
            install,
            restorePin,
          );
        },
        restorePin ? deferRestoredFlowLink : undefined,
      );

      if (!changed) staleLaunchAdoption();
      const [applied] = await tx
        .select({ id: declarations.id, generation: declarations.generation })
        .from(declarations)
        .where(eq(declarations.id, prior.id));

      if (!applied) staleLaunchAdoption();

      return {
        attachmentId: opts.attachmentId,
        priorInstallId: expected.installId,
        priorPin: {
          source: prior.desired.source,
          version: prior.desired.version,
          ...(prior.desired.path === undefined
            ? {}
            : { path: prior.desired.path }),
        },
        applied: { installId: opts.packageInstallId, declaration: applied },
      };
    },
    opts.onCommitted,
  );

  if (!receipt) staleLaunchAdoption();

  return receipt;
}

// Undo restores the fenced DB pin even if the checkout link is occupied. The
// same durable outbox validates ownership before it touches that path.
async function deferRestoredFlowLink(): Promise<void> {}

export async function workerUpgradeAttachment(
  opts: UpgradeAttachmentOptions & { linkOperationId: string },
  recordActual: RecordAttachment,
  projectLink?: typeof validateProjectFlowLink,
): Promise<{ upgraded: boolean } | null> {
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

  // Host READS, before the transaction (ADR-179 D18). A version that DROPS a
  // reference re-caches as Ready here — the verdict is rebuilt, never merged.
  const readinessByRef = await packageReadinessByRef(next);
  const agentDefinitions = (await readPackageAgentSources(next.installedPath))
    .filter((source) => {
      const parsed = splitFrontmatter(source.content);

      return parsed.ok && parsed.frontmatter?.task_qualification !== undefined;
    })
    .map((source) =>
      parseAgentDefinition(
        qualifyAgentId(next.name, source.stem),
        source.content,
      ),
    );

  await db.transaction(async (tx: Tx) => {
    const repoPath = await lockDependencyProject(tx, opts.projectId);

    await lockAttachment(tx, att.id, att.packageInstallId);
    await assertPackageMemberOwnership(
      tx,
      opts.projectId,
      manifestOf(next).spec.flows.map((flow) => flow.id),
      att.packageInstallId,
    );
    await assertCapabilityMemberOwnership(
      tx,
      opts.projectId,
      manifestOf(next).spec.capabilities.map((member) => member.id),
      next.resolvedRevision,
      att.packageInstallId,
    );
    await recordActual(tx, att.id, next);
    await assertAttachedQualificationAgentsPolicy(
      tx,
      opts.projectId,
      agentDefinitions,
    );
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

    const { memberFlows } = await wireMembers(
      tx,
      {
        projectId: opts.projectId,
        projectSlug: opts.projectSlug,
        workspaceRoot: opts.workspaceRoot ?? repoPath,
        roleRefs: opts.roleRefs,
        install: next,
        readinessByRef,
        preparedMembers: opts.preparedMembers,
        signal: opts.signal,
      },
      projectLink,
    );
    const flowRowIds = memberFlows.map((m) => m.flowRowId);

    // Removed members lose enablement, never their pinned run history.
    const removedFlows = await tx
      .select({ id: flows.id, flowRefId: flows.flowRefId })
      .from(flows)
      .where(
        and(
          eq(flows.projectId, opts.projectId),
          eq(flows.packageInstallId, att.packageInstallId),
          flowRowIds.length > 0 ? notInArray(flows.id, flowRowIds) : undefined,
        ),
      )
      .for("update");
    const removedFlowIds: string[] = removedFlows.map(
      (flow: { id: string }) => flow.id,
    );

    await queueProjectFlowLinks(
      tx,
      opts.linkOperationId,
      opts.projectId,
      opts.workspaceRoot ?? repoPath,
      [
        ...manifestOf(next).spec.flows.map((f) => f.id),
        ...removedFlows.map((f: { flowRefId: string }) => f.flowRefId),
      ],
    );
    await deleteMemberEnablements(tx, removedFlowIds);

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
  actorUserId?: string;
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

  const historicalInventory =
    !manifest.inventory?.skillsByCapability &&
    manifest.spec.capabilities.length &&
    (await verifyCachedPackage(install))
      ? await collectInventory(install.installedPath, manifest.spec)
      : null;
  const queued = await db.transaction(async (tx: Tx) => {
    const current = await tx.execute<{
      id: string;
    }>(sql`SELECT a.project_id AS id
      FROM project_package_attachments a
      JOIN project_dependency_declarations d ON d.effective_attachment_id=a.id AND d.project_id=a.project_id
        AND d.effective_generation=d.generation
      JOIN projects p ON p.id=a.project_id AND p.archived_at IS NULL
      WHERE a.package_install_id=${install.id} ORDER BY a.project_id FOR UPDATE OF p`);
    const projectIds = current.rows.map((row) => row.id);

    if (opts.actorUserId) await requireDependencyAdmin(tx, opts.actorUserId);
    if (historicalInventory)
      await storeVerifiedInventory(tx, install.id, historicalInventory);
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
    await refreshPackageCapabilityTrust(tx, install.id);

    for (const projectId of projectIds) {
      await enableReadyTrustedPackageFlows(tx, install.id, projectId);
      await reconcileDependencyCatalog(tx, projectId);
    }
    const attempts = await enqueueTrustedSetup(tx, opts.actorUserId, {
      kind: "package",
      id: install.id,
    });

    return { attempts, projectIds };
  });

  await finishTrustedSetup(db, queued.attempts, opts.signal);
  if (!opts.actorUserId) {
    for (const projectId of queued.projectIds)
      await settleTrustedPackageSetup(db, install, opts.signal, projectId);
  }

  return { trusted: true };
}

export async function settleTrustedPackageSetup(
  db: Db,
  install: typeof packageInstalls.$inferSelect,
  signal: AbortSignal | undefined,
  projectId: string,
): Promise<void> {
  const flowIds = manifestOf(install).spec.flows.map((f) => f.id);
  // Post-trust setup (AFTER the tx): member bundles first, then member flow
  // revisions with pending setup.
  const capRows = await db
    .select({
      id: schemaModule.capabilityImports.id,
      projectId: schemaModule.capabilityImports.projectId,
      capabilityRefId: schemaModule.capabilityImports.capabilityRefId,
      setupStatus: schemaModule.capabilityImports.setupStatus,
    })
    .from(capabilityImports)
    .where(
      and(
        eq(capabilityImports.packageInstallId, install.id),
        eq(capabilityImports.projectId, projectId),
      ),
    );

  for (const row of capRows) {
    if (row.setupStatus === "pending" || row.setupStatus === "failed") {
      const outcome = await runCapabilityRevisionSetup({
        importRowId: row.id,
        db,
        signal,
      });

      if (outcome.setupStatus === "failed") {
        throw new MaisterError(
          "FLOW_INSTALL",
          "A trusted package capability failed setup.",
          {
            details: { reason: "setup_failed", memberRef: row.capabilityRefId },
          },
        );
      }
    }
  }

  const affectedProjects = new Set<string>(
    capRows.map((row: { projectId: string }) => row.projectId),
  );

  for (const projectId of affectedProjects) {
    await db.transaction((tx: DependencyTransaction) =>
      reconcileDependencyCatalog(tx, projectId),
    );
  }

  if (flowIds.length > 0) {
    const revRows = await db
      .select()
      .from(flowRevisions)
      .where(
        and(
          eq(flowRevisions.resolvedRevision, install.resolvedRevision),
          inArray(flowRevisions.flowRefId, flowIds),
          sql`EXISTS (SELECT 1 FROM flows mf WHERE mf.enabled_revision_id=${flowRevisions.id}
            AND mf.project_id=${projectId} AND mf.package_install_id=${install.id})`,
        ),
      );

    for (const rev of revRows) {
      const rerun =
        rev.setupStatus === "pending" || rev.setupStatus === "failed";
      const setupStatus = rerun
        ? await runRevisionSetup({
            revisionId: rev.id,
            installedPath: rev.installedPath,
            db,
            signal,
          })
        : rev.setupStatus;

      if (setupStatus === "failed") {
        throw new MaisterError(
          "FLOW_INSTALL",
          "A trusted package Flow failed setup.",
          {
            details: { reason: "setup_failed", memberRef: rev.flowRefId },
          },
        );
      }
    }
    await enableReadyTrustedPackageFlows(db, install.id, projectId);
  }

  log.info(
    { packageInstallId: install.id, flows: flowIds.length },
    "package revision trusted (fan-out complete)",
  );
}

async function enableReadyTrustedPackageFlows(
  db: Db,
  installId: string,
  projectId: string,
): Promise<void> {
  const candidates = await db
    .select({ revision: schemaModule.flowRevisions })
    .from(schemaModule.flows)
    .innerJoin(
      schemaModule.flowRevisions,
      eq(schemaModule.flowRevisions.id, schemaModule.flows.enabledRevisionId),
    )
    .where(
      and(
        eq(schemaModule.flows.projectId, projectId),
        eq(schemaModule.flows.packageInstallId, installId),
        eq(schemaModule.flows.enablementState, "Installed"),
      ),
    );
  const ready = candidates
    .filter(
      ({ revision }) =>
        isReadyFlowRevision(revision) &&
        !requiresExplicitNativeFindingsEnablement(
          revision.manifest as InstallResult["manifest"],
        ),
    )
    .map(({ revision }) => revision.id);

  if (!ready.length) return;
  await db
    .update(flows)
    .set({ enablementState: "Enabled", updatedAt: new Date() })
    .where(
      and(
        eq(flows.projectId, projectId),
        eq(flows.packageInstallId, installId),
        eq(flows.trustStatus, "trusted"),
        eq(flows.enablementState, "Installed"),
        inArray(flows.enabledRevisionId, ready),
        sql`EXISTS (SELECT 1 FROM project_package_attachments a JOIN project_dependency_declarations d
      ON d.effective_attachment_id=a.id AND d.project_id=a.project_id AND d.effective_generation=d.generation
      WHERE a.project_id=${projectId} AND a.package_install_id=${installId})`,
        sql`NOT EXISTS (SELECT 1 FROM flow_runner_remaps remap WHERE remap.project_id=${flows.projectId}
      AND remap.flow_revision_id=${flows.enabledRevisionId} AND remap.status='Pending')`,
      ),
    );
}
