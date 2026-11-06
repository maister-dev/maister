import "server-only";

import type { RuntimeObjectWithRun } from "@/lib/execution-host/runtime-objects";

import { requireProjectAction } from "@/lib/authz";
import { assertCompanyRunReadAccess } from "@/lib/agents/company-run-read-access";
import { MaisterError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";
import { assertRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import { assertLocalPackageAssistantActor } from "@/lib/scratch-runs/authorization";

export async function authorizeRuntimeObjectActor(
  loaded: RuntimeObjectWithRun,
  userId: string,
): Promise<void> {
  if (loaded.companyId) {
    try {
      await assertCompanyRunReadAccess(getDb(), userId, loaded.object.runId);
    } catch (error) {
      if (
        error instanceof MaisterError &&
        error.details?.reason === "run_unavailable"
      ) {
        throw new MaisterError("PRECONDITION", "runtime object was not found", {
          details: { reason: "runtime_object_not_found" },
        });
      }
      throw error;
    }

    return;
  }
  if (loaded.projectId) {
    await requireProjectAction(loaded.projectId, "readBoard");
    await assertRunKnowledgeDisclosure(
      getDb(),
      { kind: "user", userId },
      loaded.object.runId,
    );

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
    await assertRunKnowledgeDisclosure(
      getDb(),
      { kind: "user", userId },
      loaded.object.runId,
    );
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
    await assertRunKnowledgeDisclosure(
      getDb(),
      { kind: "user", userId },
      loaded.object.runId,
    );

    return;
  }
  await authorizeRuntimeObjectActor(loaded, userId);
}
