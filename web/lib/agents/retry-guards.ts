import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { MaisterError } from "@/lib/errors";
import { projectRolesForActions } from "@/lib/authz";

export function retryDigest(value: unknown): string {
  return createHash("sha256").update(canonicalCommandJson(value)).digest("hex");
}

export function retryRefusal(reason: string): MaisterError {
  return new MaisterError("CONFLICT", `Agent retry refused: ${reason}`, {
    details: { reason },
  });
}

export async function assertRetryAuthority(
  db: Db,
  projectId: string,
  userId: string,
): Promise<void> {
  const roles = projectRolesForActions(["launchRun"]);
  const allowed =
    await db.execute(sql`SELECT u.id FROM users u JOIN projects p ON p.id=${projectId}
    WHERE u.id=${userId} AND u.account_status='active' AND NOT u.must_change_password AND p.archived_at IS NULL
      AND (u.role='admin' OR EXISTS(SELECT 1 FROM project_members membership
        WHERE membership.project_id=p.id AND membership.user_id=u.id AND membership.role IN ${roles})) FOR SHARE OF u,p`);

  if (!allowed.rows.length)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current project launch permission is required",
      { details: { reason: "retry_authority_revoked" } },
    );
}

/** Positive machine evidence is required; absence of a result or prompt alone never proves pre-work failure. */
export async function retrySafetyReason(
  db: Db,
  source: Run,
): Promise<string | null> {
  if (
    source.runKind !== "agent" ||
    source.persistent ||
    source.parentRunId ||
    source.workspaceMode === "shared"
  )
    return "retry_source_unsupported";
  if (source.status !== "Failed" && source.status !== "Crashed")
    return "retry_source_not_failed";
  const unsafe = await db.execute(sql`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM run_sessions session WHERE session.run_id=${source.id} AND session.acp_session_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM run_session_incarnations incarnation WHERE incarnation.run_id=${source.id} AND incarnation.state IN ('created','active'))
    OR EXISTS(SELECT 1 FROM execution_assignments assignment WHERE assignment.run_id=${source.id} AND assignment.state='active')
    OR EXISTS(SELECT 1 FROM execution_commands command WHERE command.run_id=${source.id}
      AND (command.kind IN ('session.prompt','session.steer') OR command.kind='session.create'
        AND NOT (command.state='failed' AND command.receipt_evidence->>'phase'='rejected'
          AND command.receipt_evidence->>'inflight'='false')))`);

  if (unsafe.rows.length) return "reconciliation_required";
  const proof = await db.execute(sql`SELECT 1 WHERE EXISTS(
    SELECT 1 FROM domain_events fact WHERE fact.run_id=${source.id} AND fact.kind IN ('run.failed','run.crashed')
      AND fact.payload->'cause'->>'source'='agent' AND fact.payload->'cause'->>'reason' IN
        ('agent_workspace_prepare_failed','agent_dispatch_failed','runner_snapshot_missing','effective_definition_unresolved'))
    OR EXISTS(SELECT 1 FROM execution_commands command WHERE command.run_id=${source.id}
      AND command.kind='session.create' AND command.state='failed'
      AND command.receipt_evidence->>'phase'='rejected' AND command.receipt_evidence->>'inflight'='false')`);

  return proof.rows.length ? null : "reconciliation_required";
}
