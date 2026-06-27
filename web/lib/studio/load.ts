import "server-only";

import type { GlobalRole, LocalPackage } from "@/lib/db/schema";

import { groupPackages, type PackageGroup } from "./group-packages";

import { MaisterError } from "@/lib/errors";
import {
  listAllLocalPackages,
  listSourceInstallsForLocalPackages,
  type LocalPackageSourceInstall,
} from "@/lib/local-packages/service";
import {
  getProjectPackageAttachments,
  getStudioPackageInstalls,
  loadPackageSourcesView,
} from "@/lib/queries/packages";
import { getAccessibleProjects } from "@/lib/queries/platform-flows";

type PackageSourcesView = Awaited<ReturnType<typeof loadPackageSourcesView>>;
const RECENT_LOCAL_PACKAGE_LIMIT = 5;

export type StudioLocalSummary = {
  activeCount: number;
  cutCount: number;
  totalCount: number;
  uncutCount: number;
};

export type StudioRecentLocalPackageOrigin =
  | { kind: "forked"; packageName: string; versionLabel: string }
  | { kind: "local" };

export type StudioRecentLocalPackage = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "archived";
  isDefault: boolean;
  origin: StudioRecentLocalPackageOrigin;
  lastCutInstallId: string | null;
  updatedAt: string;
};

export type StudioSourceSummary = {
  sourceCount: number;
  enabledSourceCount: number;
  discoveredPackageCount: number;
  discoveredTagCount: number;
};

export type StudioOverview = {
  groups: PackageGroup[];
  localSummary: StudioLocalSummary;
  recentLocalPackages: StudioRecentLocalPackage[];
  sourceSummary: StudioSourceSummary | null;
};

export type StudioPackageResolution =
  | { status: "not-found" }
  | { status: "ambiguous"; matches: PackageGroup[] }
  | { status: "ok"; group: PackageGroup; installId: string };

// Resolves a Studio package detail `ref` (the package name, Phase A) to its
// newest install. Two sources can expose the same name → `ambiguous` (the caller
// surfaces the collision rather than silently picking one). Shared by the package
// detail page and its flow/skill/agent sub-pages (M36).
export async function resolveStudioPackageByRef(
  userId: string,
  userRole: GlobalRole,
  ref: string,
): Promise<StudioPackageResolution> {
  const groups = await loadStudioPackages(userId, userRole);
  const matches = groups.filter((group) => group.name === ref);

  if (matches.length === 0) return { status: "not-found" };
  if (matches.length > 1) return { status: "ambiguous", matches };

  const group = matches[0];

  return {
    status: "ok",
    group,
    installId: group.versions[0]?.installId ?? "",
  };
}

// Instance-wide Studio package view: every installed package grouped by
// `(sourceUrl, name)`, with attachment counts gathered across the viewer's
// accessible projects. Read errors propagate (never swallowed) so the page
// surfaces them rather than silently rendering an empty Studio.
export async function loadStudioPackages(
  userId: string,
  userRole: GlobalRole,
): Promise<PackageGroup[]> {
  const [installs, projects] = await Promise.all([
    getStudioPackageInstalls(),
    getAccessibleProjects(userId, userRole),
  ]);

  const attachmentBatches = await Promise.all(
    projects.map(async (project) => {
      const attachments = await getProjectPackageAttachments(project.id);

      return attachments.map((attachment) => ({
        packageInstallId: attachment.packageInstallId,
        projectId: project.id,
      }));
    }),
  );

  return groupPackages({ installs, attachments: attachmentBatches.flat() });
}

export async function loadStudioOverview(
  userId: string,
  userRole: GlobalRole,
): Promise<StudioOverview> {
  const [groups, localPackages, sourcesView] = await Promise.all([
    loadStudioPackages(userId, userRole),
    listAllLocalPackages(),
    userRole === "admin"
      ? loadPackageSourcesView()
      : Promise.resolve<PackageSourcesView | null>(null),
  ]);
  const sourceInstalls = await listSourceInstallsForLocalPackages(localPackages);

  return {
    groups,
    localSummary: summarizeLocalPackages(localPackages),
    recentLocalPackages: localPackages
      .slice(0, RECENT_LOCAL_PACKAGE_LIMIT)
      .map((pkg) => toRecentLocalPackage(pkg, sourceInstalls)),
    sourceSummary: sourcesView
      ? summarizePackageSources(sourcesView.sources)
      : null,
  };
}

function summarizeLocalPackages(
  localPackages: LocalPackage[],
): StudioLocalSummary {
  const active = localPackages.filter((pkg) => pkg.status === "active");
  const cutCount = active.filter((pkg) => pkg.lastCutInstallId !== null).length;

  return {
    activeCount: active.length,
    cutCount,
    totalCount: localPackages.length,
    uncutCount: active.filter((pkg) => pkg.lastCutInstallId === null).length,
  };
}

function toRecentLocalPackage(
  pkg: LocalPackage,
  sourceInstalls: Map<string, LocalPackageSourceInstall>,
): StudioRecentLocalPackage {
  return {
    id: pkg.id,
    name: pkg.name,
    slug: pkg.slug,
    status: pkg.status,
    isDefault: pkg.isDefault,
    origin: recentLocalPackageOrigin(pkg, sourceInstalls),
    lastCutInstallId: pkg.lastCutInstallId,
    updatedAt: pkg.updatedAt.toISOString(),
  };
}

function recentLocalPackageOrigin(
  pkg: LocalPackage,
  sourceInstalls: Map<string, LocalPackageSourceInstall>,
): StudioRecentLocalPackageOrigin {
  if (!pkg.sourceInstallId) return { kind: "local" };

  const sourceInstall = sourceInstalls.get(pkg.sourceInstallId);

  if (!sourceInstall) {
    throw new MaisterError(
      "CONFIG",
      `local package ${pkg.id} points to missing source install ${pkg.sourceInstallId}`,
      {
        details: {
          localPackageId: pkg.id,
          sourceInstallId: pkg.sourceInstallId,
        },
      },
    );
  }

  return {
    kind: "forked",
    packageName: sourceInstall.name,
    versionLabel: sourceInstall.versionLabel,
  };
}

function summarizePackageSources(
  sources: PackageSourcesView["sources"],
): StudioSourceSummary {
  const discoveredPackages = new Set(
    sources.flatMap((source) =>
      source.discovered.map((pkg) => `${source.url}:${pkg.name}`),
    ),
  );

  return {
    sourceCount: sources.length,
    enabledSourceCount: sources.filter((source) => source.enabled).length,
    discoveredPackageCount: discoveredPackages.size,
    discoveredTagCount: sources.reduce(
      (sum, source) =>
        sum +
        source.discovered.reduce((tagSum, pkg) => tagSum + pkg.tags.length, 0),
      0,
    ),
  };
}
