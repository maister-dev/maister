import "server-only";

import type { GlobalRole } from "@/lib/db/schema";

import { groupPackages, type PackageGroup } from "./group-packages";

import {
  getProjectPackageAttachments,
  getStudioPackageInstalls,
} from "@/lib/queries/packages";
import { getAccessibleProjects } from "@/lib/queries/platform-flows";

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
