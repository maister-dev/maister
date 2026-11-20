import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

type VaultNode = Readonly<{ project_id: string; node_id: string }>;

/** Distinguish sibling attempts without relying on the run's single progress cursor. */
export async function currentVaultNodeAttempt(
  tx: Db,
  runId: string,
  nodeAttemptId: string,
): Promise<VaultNode | undefined> {
  await tx.execute(
    sql`SELECT id FROM runs WHERE id=${runId} FOR NO KEY UPDATE`,
  );
  const { rows } = await tx.execute<VaultNode>(sql`
    SELECT r.project_id, n.node_id
    FROM node_attempts n JOIN runs r ON r.id=n.run_id
    WHERE n.id=${nodeAttemptId} AND r.id=${runId}
      AND r.run_kind='flow' AND r.project_id IS NOT NULL AND r.company_id IS NULL
      AND r.status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren')
      AND n.node_type IN ('ai_coding','orchestrator')
      AND n.status IN ('Running','NeedsInput')
      AND NOT EXISTS (
        SELECT 1 FROM node_attempts newer
        WHERE newer.run_id=r.id AND newer.node_id=n.node_id AND newer.attempt>n.attempt
      )
    FOR SHARE OF n
  `);

  return rows[0];
}

export async function boundFlowVaultPersona(
  tx: Db,
  runId: string,
  nodeAttemptId: string,
  projectId: string,
): Promise<string | null> {
  const node = await currentVaultNodeAttempt(tx, runId, nodeAttemptId);

  if (node?.project_id !== projectId) return null;
  const { rows } = await tx.execute<{ agent_id: string }>(sql`
    SELECT v.agent_id
    FROM agent_memory_injections i JOIN agent_memory_vaults v ON v.id=i.vault_id
    WHERE i.run_id=${runId} AND i.node_attempt_id=${nodeAttemptId}
      AND i.session_key=${nodeAttemptId} AND i.application_state <> 'retired'
      AND v.project_id=${projectId}
  `);

  return rows[0]?.agent_id ?? null;
}
