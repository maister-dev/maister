import "server-only";

import type {
  KnowledgeAccessCapture,
  KnowledgeAccessRestriction,
} from "@/lib/company/types";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { RunResultContract } from "@/lib/run-results/types";

import { sql } from "drizzle-orm";

import { canonicalKnowledgeRestrictions } from "./knowledge-disclosure";

import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";

/** Initialize only the native capture protocol; historical contracts retain unknown classification. */
export async function nativeKnowledgeCaptureAtLaunch(
  tx: SqlTransaction,
  contract: RunResultContract | null,
  input: Readonly<{
    parentRunId: string | null;
    sourceRestrictions: readonly KnowledgeAccessRestriction[];
  }>,
): Promise<KnowledgeAccessCapture | null> {
  const nativeResult =
    contract?.kind !== "agent_operational" &&
    contract?.nativeContract === FINDINGS_CONTRACT;
  let inherited: readonly KnowledgeAccessRestriction[] = [];
  let enrolledParent = false;

  if (input.parentRunId !== null) {
    const row = (
      await tx.execute(
        sql`SELECT knowledge_access FROM runs WHERE id=${input.parentRunId} FOR SHARE`,
      )
    ).rows[0];

    enrolledParent =
      row?.knowledge_access !== null && row?.knowledge_access !== undefined;
    if (!enrolledParent && !nativeResult) return null;
    const parent = knowledgeAccessCaptureSchema.safeParse(
      row?.knowledge_access,
    );

    if (!parent.success || parent.data.state !== "complete")
      throw new MaisterError(
        "PRECONDITION",
        "A native child requires complete server-recorded parent source capture; resume compatible work instead of upgrading historical provenance",
        { details: { reason: "knowledge_capture_profile_required" } },
      );
    inherited = parent.data.restrictions;
  }
  if (!nativeResult && !enrolledParent) return null;
  const restrictions = canonicalKnowledgeRestrictions([
    ...input.sourceRestrictions,
    ...inherited,
  ]);

  if (Buffer.byteLength(JSON.stringify(restrictions), "utf8") > 65536)
    throw new MaisterError(
      "PRECONDITION",
      "Inherited native knowledge capture exceeds its bounded transport contract",
      { details: { reason: "knowledge_capture_limit" } },
    );

  const capture = knowledgeAccessCaptureSchema.safeParse({
    schemaVersion: 1,
    state: "complete",
    generation: 1,
    restrictions,
  });

  if (!capture.success)
    throw new MaisterError(
      "PRECONDITION",
      "Native execution input source classification exceeds its bounded contract",
      { details: { reason: "knowledge_capture_limit" } },
    );

  return capture.data;
}
