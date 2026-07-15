import "server-only";

import type { Project } from "@/lib/db/schema";
import type { BrainUiDb } from "@/lib/brain/ui-queries";

import { isBrainSchemaApplied } from "./guard";
import { getBrainSettings, isEmbeddingConfigured } from "./settings";

import { getDb } from "@/lib/db/client";

export interface ProjectBrainTabAvailability {
  brainEnabled: boolean;
  brainSchemaApplied: boolean;
  embeddingConfigured: boolean;
}

export function canShowProjectBrainTab({
  brainEnabled,
  brainSchemaApplied,
  embeddingConfigured,
}: ProjectBrainTabAvailability): boolean {
  return brainEnabled && brainSchemaApplied && embeddingConfigured;
}

export async function isProjectBrainIndexingAvailable(
  project: Pick<Project, "brainEnabled">,
): Promise<boolean> {
  if (!project.brainEnabled) return false;

  const db = getDb() as unknown as BrainUiDb;
  const [brainSchemaApplied, settings] = await Promise.all([
    isBrainSchemaApplied(db),
    getBrainSettings(db),
  ]);

  return canShowProjectBrainTab({
    brainEnabled: project.brainEnabled,
    brainSchemaApplied,
    embeddingConfigured: isEmbeddingConfigured(settings),
  });
}
