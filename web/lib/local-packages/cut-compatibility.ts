import "server-only";

import type { LocalPackage } from "@/lib/db/schema";
import type { PackageArtifactFile } from "@/lib/local-packages/validate";

import { parse as parseYaml } from "yaml";

import { classifyStoredFlowManifest } from "@/lib/flows/manifest-parser";
import { LEGACY_STEPS_REFUSAL_MESSAGE } from "@/lib/flows/manifest-shape";
import { readWorkingDirArtifactFiles } from "@/lib/local-packages/service";

export type LocalPackageCutCompatibility = {
  compatible: boolean;
  incompatibilityReason: string | null;
};

export const INVALID_LOCAL_FLOW_MANIFEST_REMEDIATION =
  "A flow manifest is invalid. Fix it before cutting a version.";

function isFlowPath(path: string): boolean {
  return path === "flow.yaml" || /^flows\/.+\/flow\.yaml$/.test(path);
}

// A cut creates an immutable version, so a graph-incompatible flow must be
// surfaced before the irreversible route is offered. This intentionally covers
// only Flow compatibility; dirty-worktree and other artifact gates remain
// server-enforced by assertPackageCuttable at the mutation boundary.
export function classifyLocalPackageCutCompatibility(
  files: readonly PackageArtifactFile[],
): LocalPackageCutCompatibility {
  for (const file of files) {
    if (!isFlowPath(file.path)) continue;

    try {
      const compatibility = classifyStoredFlowManifest(parseYaml(file.content));

      if (compatibility.compatible) continue;

      return {
        compatible: false,
        incompatibilityReason:
          compatibility.reason.kind === "legacy_steps"
            ? LEGACY_STEPS_REFUSAL_MESSAGE
            : compatibility.reason.kind === "engine_incompatible"
              ? compatibility.reason.message
              : INVALID_LOCAL_FLOW_MANIFEST_REMEDIATION,
      };
    } catch {
      return {
        compatible: false,
        incompatibilityReason: INVALID_LOCAL_FLOW_MANIFEST_REMEDIATION,
      };
    }
  }

  return { compatible: true, incompatibilityReason: null };
}

export async function getLocalPackageCutCompatibility(
  pkg: LocalPackage,
): Promise<LocalPackageCutCompatibility> {
  const files = await readWorkingDirArtifactFiles(pkg);

  return classifyLocalPackageCutCompatibility(files);
}
