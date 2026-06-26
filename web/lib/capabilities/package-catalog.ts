import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { ProjectCapabilityCatalogEntry } from "@/lib/capabilities/project-catalog";
import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { capabilitySurfaceFor } from "@/lib/acp-runners/adapter-support";
import { chipToCanonical } from "@/lib/capabilities/composer-serialize";
import { surfaceFormForSkill } from "@/lib/capabilities/token-normalizer";

// Pure, client-safe: the studio editor is project-less, so the composer's
// autocomplete catalog is derived from the package's OWN files rather than the
// project DB (getProjectCapabilityCatalog). Mirrors the project-catalog entry
// shape (skillCatalogEntry) so the same CapabilityComposer renders both.

const SKILL_PATH_RE = /^skills\/([^/]+)\/SKILL\.md$/;

export function buildPackageCapabilityCatalog(
  files: readonly AuthoredFlowPackageFile[],
  adapter: AdapterId,
): ProjectCapabilityCatalogEntry[] {
  const skillsSupported = capabilitySurfaceFor(adapter).skills;

  return files
    .flatMap((file) => {
      const match = SKILL_PATH_RE.exec(file.path);

      if (!match) return [];

      const slug = match[1];

      return [
        {
          kind: "skill" as const,
          refId: slug,
          slug,
          displayName: slug,
          description: null,
          argHint: null,
          canonicalToken: chipToCanonical("skill", slug),
          surfaceForm: surfaceFormForSkill(slug, adapter),
          supported: skillsSupported,
        },
      ];
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}
