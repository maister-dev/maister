import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { RunResultContract } from "@/lib/run-results/types";

import { sql } from "drizzle-orm";

import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors";
import { isNativeFindingsContract } from "@/lib/run-results/contract";

type PublicationSource = Readonly<{
  workspaceMode?: unknown;
  resultContract?: RunResultContract | null;
  knowledgeAccess?: unknown;
}>;

export type ProjectPublicationPolicy =
  "legacy" | "project_context" | "restricted" | "unavailable";

/** Repository delivery retains only the destination project's existing context policy. */
export function projectPublicationPolicy(
  source: PublicationSource,
  projectId: string,
): ProjectPublicationPolicy {
  if (
    !isNativeFindingsContract(source.resultContract) &&
    source.knowledgeAccess == null
  )
    return "legacy";
  if (source.workspaceMode === "shared") return "unavailable";
  const capture = knowledgeAccessCaptureSchema.safeParse(
    source.knowledgeAccess,
  );

  if (!capture.success || capture.data.state !== "complete")
    return "unavailable";

  return capture.data.restrictions.every(
    (restriction) =>
      restriction.kind === "project_context" &&
      restriction.projectId === projectId,
  )
    ? "project_context"
    : "restricted";
}

function publicationRefusal(policy: ProjectPublicationPolicy): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "This run's knowledge cannot be shared through project Git delivery. Keep its protected result or submit a knowledge proposal.",
    {
      details: {
        reason: "native_publication_source_policy",
        sourcePolicy: policy,
      },
    },
  );
}

/** Recheck retained source metadata at the existing mutation boundary; no Brain read or publication authority is inferred. */
export async function assertNativeProjectPublication(
  database: () => SqlTransaction,
  run: PublicationSource & Readonly<{ id: string; projectId: string }>,
): Promise<void> {
  const policy = projectPublicationPolicy(run, run.projectId);

  if (policy === "legacy") return;
  if (policy !== "project_context") throw publicationRefusal(policy);
  const row = (
    await database().execute(
      sql`SELECT project_id,result_contract,knowledge_access,workspace_mode FROM runs WHERE id=${run.id}`,
    )
  ).rows[0];

  if (!row || row.project_id !== run.projectId)
    throw publicationRefusal("unavailable");
  const current = projectPublicationPolicy(
    {
      resultContract: row.result_contract as RunResultContract | null,
      knowledgeAccess: row.knowledge_access,
      workspaceMode: row.workspace_mode,
    },
    run.projectId,
  );

  if (current !== "project_context")
    throw publicationRefusal(current === "legacy" ? "unavailable" : current);
}
