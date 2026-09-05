import "server-only";

import type { RuntimeObjectWithRun } from "@/lib/execution-host/runtime-objects";

import { requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { assertLocalPackageAssistantActor } from "@/lib/scratch-runs/authorization";

export async function authorizeRuntimeObjectActor(
  loaded: RuntimeObjectWithRun,
  userId: string,
): Promise<void> {
  if (loaded.projectId) {
    await requireProjectAction(loaded.projectId, "readBoard");

    return;
  }
  if (!loaded.localPackageId) {
    throw new MaisterError("PRECONDITION", "runtime object was not found", {
      details: { reason: "runtime_object_not_found" },
    });
  }

  try {
    await assertLocalPackageAssistantActor(loaded, userId, {
      requireLock: false,
    });
  } catch (error) {
    if (!(error instanceof MaisterError) || error.code !== "UNAUTHORIZED") {
      throw error;
    }
    throw new MaisterError("PRECONDITION", "runtime object was not found", {
      details: { reason: "runtime_object_not_found" },
    });
  }
}

/** Repository-derived bytes require a content grant in addition to metadata access. */
export async function authorizeRuntimeObjectContentActor(
  loaded: RuntimeObjectWithRun,
  userId: string,
): Promise<void> {
  if (loaded.projectId) {
    await requireProjectAction(loaded.projectId, "readRepoFiles");

    return;
  }
  await authorizeRuntimeObjectActor(loaded, userId);
}
