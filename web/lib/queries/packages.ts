import "server-only";

import type { PackageInstallRow } from "@/components/settings/package-sources-panel";
import type { PackageSourceRow } from "@/components/settings/package-source-modal";
import type { DiscoveredPackageEntry } from "@/lib/db/schema";
import type { PackageBom } from "@/lib/queries/package-bom";
import type { PackageInstallManifest } from "@/lib/packages/attach";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";

import { join } from "node:path";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { loadFlowManifest } from "@/lib/config";
import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveConfinedFlowYaml } from "@/lib/flows/package-content";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import {
  classifyVersionTargets,
  defaultPackageSourceUrls,
  deriveUpdateAvailable,
  type PackageVersionTarget,
} from "@/lib/packages/catalog";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import {
  buildPackageBom,
  installedPackageSource,
} from "@/lib/queries/package-bom";

// Re-exported for existing importers of `@/lib/queries/packages` (ADR-116 moved
// the canonical definitions to `package-bom.ts`).
export type {
  PackageBom,
  PackageBomAgent,
  PackageBomFlow,
  PackageBomFlowFrontmatter,
  PackageBomFlowGraph,
  PackageBomMcp,
  PackageBomRule,
  PackageBomSkill,
  PackageBomSubagent,
} from "@/lib/queries/package-bom";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls, packageSources, projectPackageAttachments } =
  schemaModule as unknown as Record<string, any>;

export type ProjectPackageVersionTarget = PackageVersionTarget & {
  compatible: boolean;
  incompatibilityReason: string | null;
};

export type ProjectPackageAttachmentView = {
  id: string;
  packageInstallId: string;
  packageName: string;
  versionLabel: string;
  resolvedRevision: string;
  trustStatus: string;
  attachedAt: string;
  updateAvailable: boolean;
  // The single newest strictly-newer installed version (default one-click
  // upgrade), and all strictly-older installed versions (explicit downgrade
  // path). An older version is NEVER surfaced as an upgrade.
  upgradeTarget: ProjectPackageVersionTarget | null;
  downgradeTargets: ProjectPackageVersionTarget[];
  flows: string[];
};

export type AvailablePackageInstallView = {
  id: string;
  name: string;
  versionLabel: string;
  resolvedRevision: string;
  trustStatus: string;
  flows: string[];
  compatible: boolean;
  incompatibilityReason: string | null;
};

type PackageCompatibility = Pick<
  AvailablePackageInstallView,
  "compatible" | "incompatibilityReason"
>;

const UNKNOWN_PACKAGE_COMPATIBILITY: PackageCompatibility = {
  compatible: false,
  incompatibilityReason: "Package flow manifest compatibility is unavailable",
};

async function packageCompatibility(
  install: any,
): Promise<PackageCompatibility> {
  const manifest = install.manifest as PackageInstallManifest | undefined;

  try {
    for (const flow of manifest?.spec.flows ?? []) {
      await loadFlowManifest(
        join(install.installedPath, flow.path, "flow.yaml"),
        {
          errorCode: "CONFIG",
          surface: "project-package-compatibility",
        },
      );
    }

    return { compatible: true, incompatibilityReason: null };
  } catch (err) {
    return {
      compatible: false,
      incompatibilityReason:
        err instanceof Error ? err.message : "Package flow manifest is invalid",
    };
  }
}

// DTO projections for the project packages tab (ADR-088). `installed_path`
// never leaves the server.
export async function getProjectPackageAttachments(
  projectId: string,
): Promise<ProjectPackageAttachmentView[]> {
  const db = getDb() as any;
  const attachments = await db
    .select()
    .from(projectPackageAttachments)
    .where(eq(projectPackageAttachments.projectId, projectId));

  if (attachments.length === 0) return [];

  const installs = await db
    .select()
    .from(packageInstalls)
    .where(
      inArray(
        packageInstalls.id,
        attachments.map((a: any) => a.packageInstallId),
      ),
    );
  const installById = new Map<string, any>(installs.map((i: any) => [i.id, i]));
  const sources = await db.select().from(packageSources);
  const discoveredByUrl = new Map<string, DiscoveredPackageEntry[]>(
    sources.map((s: any) => [s.url, s.discovered ?? []]),
  );

  const attachedNames = [
    ...new Set(attachments.map((a: any) => a.packageName as string)),
  ];
  const siblingInstalls = await db
    .select()
    .from(packageInstalls)
    .where(
      and(
        eq(packageInstalls.packageStatus, "Installed"),
        inArray(packageInstalls.name, attachedNames),
      ),
    );

  const compatibilityByInstallId = new Map<string, PackageCompatibility>(
    await Promise.all(
      siblingInstalls.map(
        async (install: any) =>
          [install.id as string, await packageCompatibility(install)] as const,
      ),
    ),
  );

  return attachments.map((att: any) => {
    const install = installById.get(att.packageInstallId);
    const manifest = install?.manifest as PackageInstallManifest | undefined;
    const { upgrade, downgrade } = classifyVersionTargets({
      currentVersionLabel: install?.versionLabel ?? "",
      candidates: install
        ? siblingInstalls
            .filter(
              (s: any) =>
                s.name === att.packageName &&
                s.sourceUrl === install.sourceUrl &&
                s.id !== install.id,
            )
            .map((s: any) => ({
              installId: s.id as string,
              versionLabel: s.versionLabel as string,
            }))
        : [],
    });

    return {
      id: att.id,
      packageInstallId: att.packageInstallId,
      packageName: att.packageName,
      versionLabel: install?.versionLabel ?? "",
      resolvedRevision: install?.resolvedRevision ?? "",
      trustStatus: install?.trustStatus ?? "untrusted",
      attachedAt:
        att.attachedAt instanceof Date
          ? att.attachedAt.toISOString()
          : String(att.attachedAt),
      updateAvailable: install
        ? deriveUpdateAvailable({
            packageName: att.packageName,
            versionLabel: install.versionLabel,
            discovered: discoveredByUrl.get(install.sourceUrl) ?? [],
          })
        : false,
      upgradeTarget: upgrade
        ? {
            ...upgrade,
            ...(compatibilityByInstallId.get(upgrade.installId) ??
              UNKNOWN_PACKAGE_COMPATIBILITY),
          }
        : null,
      downgradeTargets: downgrade.map((target) => ({
        ...target,
        ...(compatibilityByInstallId.get(target.installId) ??
          UNKNOWN_PACKAGE_COMPATIBILITY),
      })),
      flows: manifest?.spec.flows.map((f) => f.id) ?? [],
    };
  });
}

export async function getAvailablePackageInstalls(): Promise<
  AvailablePackageInstallView[]
> {
  const db = getDb() as any;
  const installs = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.packageStatus, "Installed"));

  return Promise.all(
    installs.map(async (install: any) => {
      const manifest = install.manifest as PackageInstallManifest | undefined;
      const compatibility = await packageCompatibility(install);

      return {
        id: install.id,
        name: install.name,
        versionLabel: install.versionLabel,
        resolvedRevision: install.resolvedRevision,
        trustStatus: install.trustStatus,
        flows: manifest?.spec.flows.map((f) => f.id) ?? [],
        ...compatibility,
      };
    }),
  );
}

// The set of project ids that have the named package attached (any version) —
// powers the Studio "attach to a project" dialog's already-attached markers.
export async function getProjectIdsAttachedToPackage(
  packageName: string,
): Promise<string[]> {
  const db = getDb() as any;
  const rows = await db
    .select({ projectId: projectPackageAttachments.projectId })
    .from(projectPackageAttachments)
    .where(eq(projectPackageAttachments.packageName, packageName));
  const projectIds = rows.map((r: any) => r.projectId as string) as string[];

  return [...new Set(projectIds)];
}

export type StudioPackageInstallView = {
  id: string;
  name: string;
  sourceUrl: string;
  versionLabel: string;
  trustStatus: string;
  counts: {
    flows: number;
    skills: number;
    platformAgents: number;
    subagents: number;
    mcps: number;
    rules: number;
  };
};

// Studio-scoped projection of installed packages: carries `sourceUrl` (for
// package grouping + the Local badge) and per-kind member counts derived from
// the stored manifest — fields the project-packages-tab DTO does not expose.
export async function getStudioPackageInstalls(): Promise<
  StudioPackageInstallView[]
> {
  const db = getDb() as any;
  const installs = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.packageStatus, "Installed"));

  return installs.map((install: any) => {
    const manifest = install.manifest as PackageInstallManifest | undefined;

    return {
      id: install.id,
      name: install.name,
      sourceUrl: install.sourceUrl,
      versionLabel: install.versionLabel,
      trustStatus: install.trustStatus,
      counts: {
        flows: manifest?.spec.flows.length ?? 0,
        skills: manifest?.inventory.skills.length ?? 0,
        platformAgents: manifest?.inventory.platformAgents?.length ?? 0,
        subagents: manifest?.inventory.agents.length ?? 0,
        mcps: manifest?.spec.mcps.length ?? 0,
        // Rules live inside capability bundles and are not inventoried in the
        // manifest (only skills/agents are); a real count needs Phase C disk reads.
        rules: 0,
      },
    };
  });
}

// Props for the platform `PackageSourcesPanel`, shared by the admin `/settings`
// page and the Studio Sources surface. Mirrors the `/settings` package slice;
// `installed_path` never leaves the server.
export async function loadPackageSourcesView(): Promise<{
  sources: PackageSourceRow[];
  installs: PackageInstallRow[];
}> {
  const db = getDb() as any;
  const builtInUrls = new Set(defaultPackageSourceUrls());
  const [pkgSources, pkgInstalls] = await Promise.all([
    db.select().from(packageSources),
    db.select().from(packageInstalls),
  ]);

  return {
    sources: pkgSources.map((s: any) => ({
      id: s.id,
      url: s.url,
      enabled: s.enabled,
      note: s.note ?? null,
      discovered: s.discovered ?? [],
      lastCheckedAt: s.lastCheckedAt ? s.lastCheckedAt.toISOString() : null,
      builtIn: builtInUrls.has(s.url),
    })),
    installs: pkgInstalls.map((i: any) => ({
      id: i.id,
      sourceUrl: i.sourceUrl,
      name: i.name,
      versionLabel: i.versionLabel,
      resolvedRevision: i.resolvedRevision,
      packageStatus: i.packageStatus,
      trustStatus: i.trustStatus,
      flows: (i.manifest?.spec?.flows ?? []).map((f: any) => f.id),
    })),
  };
}

// Bill-of-materials for one package install (ADR-116: now a thin adapter over the
// shared `buildPackageBom` via an installed `PackageSource` — output is unchanged,
// pinned by a characterization snapshot). `installed_path` never leaves the server.
export async function getStudioPackageBom(
  installId: string,
): Promise<PackageBom | null> {
  const db = getDb() as any;
  const rows = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installId));
  const install = rows[0];

  if (!install) return null;

  return buildPackageBom(
    installedPackageSource({
      id: install.id as string,
      installedPath: install.installedPath as string,
      manifest: install.manifest as PackageInstallManifest | undefined,
    }),
  );
}

export type StudioFlowGraph = {
  flowId: string;
  topology: GraphTopology;
  layout: FlowLayout;
};

// Read-only graph per member flow of an installed package, for the Studio package
// preview. Each flow.yaml is read from the package's on-disk install path
// (server-controlled `installedPath` + a validated package-relative `path` — no
// user input, no traversal) and compiled. A flow missing on disk or failing to
// parse/compile is omitted — a best-effort preview that never throws.
export async function getStudioPackageFlowGraphs(
  installId: string,
): Promise<StudioFlowGraph[]> {
  const db = getDb() as any;
  const rows = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installId));
  const install = rows[0];

  if (!install) return [];

  const manifest = install.manifest as PackageInstallManifest | undefined;
  const graphs: StudioFlowGraph[] = [];

  for (const flow of manifest?.spec.flows ?? []) {
    try {
      const real = await resolveConfinedFlowYaml(
        install.installedPath,
        flow.path,
      );

      if (!real) continue;

      const parsed = await loadFlowManifest(real);

      graphs.push({
        flowId: flow.id,
        topology: buildGraphTopology(compileManifest(parsed)),
        layout: presentationLayout(parsed),
      });
    } catch {
      // Missing/invalid flow.yaml on disk → omit from the preview, never throw.
    }
  }

  return graphs;
}
