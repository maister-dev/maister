import "server-only";

import type { PackageBomFlow } from "@/lib/queries/packages";

import {
  getProjectPackageAttachments,
  getStudioPackageBom,
} from "@/lib/queries/packages";

export type ProjectPackageContentView = {
  packageName: string;
  versionLabel: string;
  flows: PackageBomFlow[];
  counts: {
    skills: number;
    agents: number;
    subagents: number;
    mcps: number;
    rules: number;
  };
};

// Per-attached-package contents for the project Packages tab: flow cards (rich
// BOM) + counts for the other artifact kinds. A package whose bundle is gone
// (null BOM) is dropped rather than shown empty. BOM reads run in parallel.
export async function getProjectPackageContents(
  projectId: string,
): Promise<ProjectPackageContentView[]> {
  const attachments = await getProjectPackageAttachments(projectId);
  const blocks = await Promise.all(
    attachments.map(async (att): Promise<ProjectPackageContentView | null> => {
      const bom = await getStudioPackageBom(att.packageInstallId);

      if (!bom) return null;

      return {
        packageName: att.packageName,
        versionLabel: att.versionLabel,
        flows: bom.flows,
        counts: {
          skills: bom.skills.length,
          agents: bom.platformAgents.length,
          subagents: bom.subagents.length,
          mcps: bom.mcps.length,
          rules: bom.rules.length,
        },
      };
    }),
  );

  return blocks.filter((b): b is ProjectPackageContentView => b !== null);
}
