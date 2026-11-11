import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { recordNativeRunSourcesInTransaction } from "@/lib/brain/knowledge-execution-access";
import { authorizeRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import { unavailableKnowledgeReference } from "@/lib/brain/knowledge-restrictions";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";
import { authorizeNativeChildInput } from "@/lib/specialist-assignments/child-authority";

/** Admit source-bearing input to a direct professional child before private turn bytes exist. */
export async function captureNativeChildInput(
  db: SqlDatabase,
  principal: Readonly<{ kind: "token"; tokenId: string }>,
  input: Readonly<{ sourceRunId: string; childRunId: string }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const exactWork = await authorizeNativeChildInput(tx, {
      parentRunId: input.sourceRunId,
      childRunId: input.childRunId,
      recipient: principal,
    });
    const source = (
      await tx.execute(
        sql`SELECT project_id,company_id,knowledge_access,result_contract->>'nativeContract' AS native_contract FROM runs WHERE id=${input.sourceRunId} FOR NO KEY UPDATE`,
      )
    ).rows[0];

    if (!source) throw unavailableKnowledgeReference();
    if (
      source.knowledge_access === null &&
      source.native_contract !== FINDINGS_CONTRACT
    )
      return;
    await authorizeRunKnowledgeDisclosure(tx, principal, input.sourceRunId);
    const origin = await resolveKnowledgePrincipal(
      tx,
      principal,
      "knowledge:read",
    );

    if (
      origin.actor.kind !== "agent" ||
      origin.actor.runId !== input.sourceRunId
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "Native child input requires the actual originating professional execution",
      );
    // Admission may expand transitive source policy; copy the current captured union, not its pre-authorization snapshot.
    const current = (
      await tx.execute(
        sql`SELECT knowledge_access FROM runs WHERE id=${input.sourceRunId}`,
      )
    ).rows[0];
    const capture = knowledgeAccessCaptureSchema.safeParse(
      current?.knowledge_access,
    );

    if (!capture.success || capture.data.state !== "complete")
      throw unavailableKnowledgeReference();
    const child = (
      await tx.execute(
        sql`SELECT project_id,company_id,parent_run_id,run_kind,knowledge_access FROM runs WHERE id=${input.childRunId} FOR NO KEY UPDATE`,
      )
    ).rows[0];

    const sameProject =
      typeof source.project_id === "string" &&
      child?.project_id === source.project_id;
    const sameCompanyWork =
      exactWork &&
      source.project_id === null &&
      child?.project_id === null &&
      typeof source.company_id === "string" &&
      child.company_id === source.company_id;

    if (
      !child ||
      (!sameProject && !sameCompanyWork) ||
      child.parent_run_id !== input.sourceRunId ||
      child.run_kind !== "agent"
    )
      throw new MaisterError(
        "PRECONDITION",
        "Native private input requires a directly delegated professional agent child",
        { details: { reason: "native_input_target_required" } },
      );
    const recipient = knowledgeAccessCaptureSchema.safeParse(
      child.knowledge_access,
    );

    if (!recipient.success || recipient.data.state !== "complete")
      throw new MaisterError(
        "PRECONDITION",
        "Native private input requires complete receiving execution source capture",
        { details: { reason: "knowledge_capture_profile_required" } },
      );
    await recordNativeRunSourcesInTransaction(
      tx,
      input.childRunId,
      capture.data.restrictions,
    );
  });
}
