import "server-only";

import type { GlobalRole } from "@/lib/db/schema";

import { groupPackages, type PackageGroup } from "./group-packages";

import {
  getProjectPackageAttachments,
  getStudioPackageInstalls,
} from "@/lib/queries/packages";
import { getAccessibleProjects } from "@/lib/queries/platform-flows";

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
