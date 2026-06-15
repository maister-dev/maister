import "server-only";

import type { PackageInstallRow } from "@/components/settings/package-sources-panel";
import type { PackageSourceRow } from "@/components/settings/package-source-modal";
import type { DiscoveredPackageEntry } from "@/lib/db/schema";
import type { PackageInstallManifest } from "@/lib/packages/attach";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { deriveUpdateAvailable } from "@/lib/packages/catalog";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls, packageSources, projectPackageAttachments } =
  schemaModule as unknown as Record<string, any>;

export type ProjectPackageAttachmentView = {
  id: string;
  packageInstallId: string;
  packageName: string;
  versionLabel: string;
  resolvedRevision: string;
  trustStatus: string;
  attachedAt: string;
  updateAvailable: boolean;
  flows: string[];
};

export type AvailablePackageInstallView = {
  id: string;
  name: string;
  versionLabel: string;
  resolvedRevision: string;
  trustStatus: string;
  flows: string[];
};

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

  return attachments.map((att: any) => {
    const install = installById.get(att.packageInstallId);
    const manifest = install?.manifest as PackageInstallManifest | undefined;

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

  return installs.map((install: any) => {
    const manifest = install.manifest as PackageInstallManifest | undefined;

    return {
      id: install.id,
      name: install.name,
      versionLabel: install.versionLabel,
      resolvedRevision: install.resolvedRevision,
      trustStatus: install.trustStatus,
      flows: manifest?.spec.flows.map((f) => f.id) ?? [],
    };
  });
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
    agents: number;
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
        agents: manifest?.inventory.agents.length ?? 0,
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

export type PackageBom = {
  flows: { id: string }[];
  agents: { id: string }[];
  skills: { id: string }[];
  mcps: { id: string }[];
  rules: { id: string }[];
};

// Bill-of-materials (artifact ids grouped by kind) for one package install,
// derived from the stored manifest + inventory. Rules are not inventoried
// (see getStudioPackageInstalls) so they come back empty until Phase C.
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

  const manifest = install.manifest as PackageInstallManifest | undefined;

  return {
    flows: (manifest?.spec.flows ?? []).map((f) => ({ id: f.id })),
    agents: (manifest?.inventory.agents ?? []).map((id) => ({ id })),
    skills: (manifest?.inventory.skills ?? []).map((id) => ({ id })),
    mcps: (manifest?.spec.mcps ?? []).map((m) => ({ id: m.id })),
    rules: [],
  };
}
