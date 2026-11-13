import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { AgentResultDecision } from "./agent-result";
import type { RunResultContract } from "./types";

import pino from "pino";

import { operationalEvidenceV2Schema } from "./operational-schema";
import { isOperationalEvidenceContract } from "./contract";

import { OPERATIONAL_EVIDENCE_CONTRACT } from "@/lib/agents/kind";
import { invalidStandResultEvidence } from "@/lib/stand-operations/result-evidence";

const log = pino({
  name: "operational-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

/** An output may name evidence. Only server-owned records can attest its effects. */
export async function validateOperationalEvidenceReferences(
  tx: SqlTransaction,
  runId: string,
  contract: RunResultContract | null,
  decision: AgentResultDecision,
): Promise<AgentResultDecision> {
  if (decision.kind !== "valid" || !isOperationalEvidenceContract(contract))
    return decision;

  const value = operationalEvidenceV2Schema.safeParse(decision.value);

  if (!value.success)
    return {
      kind: "invalid",
      reason: "schema_mismatch",
      message: "Output does not match operational evidence v2",
    };
  const path = await invalidStandResultEvidence(tx, runId, value.data);

  if (path === null) return decision;

  log.warn(
    {
      runId,
      contract: OPERATIONAL_EVIDENCE_CONTRACT,
      schemaSha256: contract.sha256,
      path,
    },
    "operational result evidence unavailable",
  );

  return {
    kind: "invalid",
    reason: "reference_invalid",
    message:
      "Required server-recorded operation or verification evidence is unavailable",
    validationDiagnostics: [{ code: "evidence_reference_unavailable", path }],
  };
}
