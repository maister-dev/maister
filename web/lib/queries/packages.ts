import "server-only";

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

// DTO projections for the project packages tab (ADR-087). `installed_path`
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
