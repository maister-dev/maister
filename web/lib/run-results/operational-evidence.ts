import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { AgentResultDecision } from "./agent-result";
import type { RunResultContract } from "./types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { operationalEvidenceV2Schema } from "./operational-schema";

import { OPERATIONAL_EVIDENCE_CONTRACT } from "@/lib/agents/kind";

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
  if (
    decision.kind !== "valid" ||
    contract?.kind !== "agent_operational" ||
    contract.contractName !== OPERATIONAL_EVIDENCE_CONTRACT
  )
    return decision;

  const value = operationalEvidenceV2Schema.parse(decision.value);
  let path: "operationIds" | "verificationIds" | null = value.operationIds
    .length
    ? "operationIds"
    : value.verificationIds.length
      ? "verificationIds"
      : null;

  // Until a server-side target resolver can witness them, submitted IDs are unavailable.
  // An empty report must also fail closed when the frozen request requires an effect or health.
  if (path === null && value.outcome === "success") {
    const [required] = (
      await tx.execute(sql`
        SELECT obligation->>'kind' AS kind
        FROM specialist_run_links link
        JOIN LATERAL (
          SELECT input.objective_input FROM specialist_input_revisions input
          WHERE input.assignment_id=link.assignment_id
            AND specialist_run_has_input(link.run_id,link.assignment_id,input.revision,input.digest)
          ORDER BY input.revision DESC LIMIT 1
        ) input ON true
        LEFT JOIN specialist_work work ON work.id=link.work_id AND work.work_revision=link.work_revision
        CROSS JOIN LATERAL jsonb_array_elements(
          coalesce(work.definition->'objectiveInput'->'verification', input.objective_input->'verification')
        ) AS obligations(obligation)
        WHERE link.run_id=${runId} AND obligation->'required'='true'::jsonb
          AND obligation->>'kind' IN ('effect','health')
        ORDER BY obligation->>'kind' LIMIT 1
      `)
    ).rows;

    if (required)
      path = required.kind === "effect" ? "operationIds" : "verificationIds";
  }
  if (path === null) return decision;

  log.warn(
    {
      runId,
      contract: contract.contractName,
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
