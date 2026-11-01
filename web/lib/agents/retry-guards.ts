import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type { AgentRetryStrategy } from "@/lib/agents/retry-types";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { MaisterError } from "@/lib/errors";
import { projectRolesForActions } from "@/lib/authz";
import { loadTaskQualificationInput } from "@/lib/tasks/qualification";

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

export async function assertQualificationRetryAuthority(
  db: Db,
  projectId: string,
  userId: string,
): Promise<void> {
  const roles = projectRolesForActions(["editTask", "launchRun"]);
  const allowed =
    await db.execute(sql`SELECT u.id FROM users u JOIN projects p ON p.id=${projectId}
    WHERE u.id=${userId} AND u.account_status='active' AND NOT u.must_change_password AND p.archived_at IS NULL
    AND (u.role='admin' OR EXISTS(SELECT 1 FROM project_members membership
      WHERE membership.project_id=p.id AND membership.user_id=u.id AND membership.role IN ${roles})) FOR SHARE OF u,p`);

  if (!allowed.rows.length)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current task editing and launch permissions are required",
      {
        details: { reason: "retry_authority_revoked" },
      },
    );
}

/** Fresh assessment does not replay the failed operation or assert its absence of business effects. */
export async function freshQualificationSafetyReason(
  db: Db,
  source: Run,
): Promise<string | null> {
  if (
    source.runKind !== "agent" ||
    source.persistent ||
    source.parentRunId ||
    source.workspaceMode === "shared" ||
    !source.taskId
  )
    return "retry_source_unsupported";
  if (source.status !== "Failed" && source.status !== "Crashed")
    return "retry_source_not_failed";
  if (!source.endedAt) return "reconciliation_required";
  const unresolved = await db.execute(sql`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM execution_assignments assignment WHERE assignment.run_id=${source.id} AND assignment.state='active')
    OR EXISTS(SELECT 1 FROM run_session_incarnations incarnation WHERE incarnation.run_id=${source.id} AND incarnation.state IN ('created','active'))
    OR EXISTS(SELECT 1 FROM execution_commands command WHERE command.run_id=${source.id}
      AND (command.state IN ('queued','delivering','accepted')
        OR command.transport_state IN ('dispatching','unknown','reconciliation_required')
        OR command.kind='session.prompt' AND command.application_state IN ('pending','applying','poisoned')))`);

  return unresolved.rows.length ? "reconciliation_required" : null;
}

export async function qualificationTaskRetryReason(
  db: Db,
  input: {
    projectId: string;
    taskId: string;
    qualificationSha: string;
    excludeIntentId?: string;
  },
): Promise<string | null> {
  const current = await loadTaskQualificationInput(
    db,
    input.projectId,
    input.taskId,
  );
  const assessment =
    await db.execute(sql`SELECT 1 FROM tasks task JOIN task_qualifications qualification ON qualification.id=task.current_qualification_id
    WHERE task.id=${input.taskId} AND task.project_id=${input.projectId}
      AND qualification.publication_state='accepted'
      AND qualification.input_revision=${current.inputRevision} AND qualification.input_digest=${current.inputDigest}
      AND qualification.revision=task.current_qualification_revision AND qualification.evidence_target=${current.target}
      AND qualification.evidence_sha=${input.qualificationSha}`);

  if (assessment.rows.length) return "retry_qualification_current";

  return concurrentQualificationReason(db, input);
}

/** Caller holds the task row lock when this predicate protects an insert. */
export async function concurrentQualificationReason(
  db: Db,
  input: { projectId: string; taskId: string; excludeIntentId?: string },
): Promise<string | null> {
  const active = await db.execute(sql`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM runs run WHERE run.project_id=${input.projectId} AND run.task_id=${input.taskId}
      AND run.status IN ('Pending','Running','NeedsInput','NeedsInputIdle','HumanWorking','WaitingOnChildren','Review'))
    OR EXISTS(SELECT 1 FROM agent_retry_intents intent WHERE intent.project_id=${input.projectId}
      AND intent.recipe->>'taskId'=${input.taskId} AND intent.state='accepted'
      AND intent.recipe->>'strategy'='fresh_qualification'
      AND (${input.excludeIntentId ?? null}::text IS NULL OR intent.id<>${input.excludeIntentId ?? null}))`);

  return active.rows.length ? "retry_task_busy" : null;
}

export async function retryStrategySafetyReason(
  db: Db,
  source: Run,
  strategy: AgentRetryStrategy,
): Promise<string | null> {
  return strategy === "fresh_qualification"
    ? freshQualificationSafetyReason(db, source)
    : retrySafetyReason(db, source);
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
      AND fact.payload->'cause'->>'source'='agent' AND
      (fact.payload->>'failurePhase'='before_dispatch'
       OR fact.payload->'cause'->>'reason' IN ('agent_workspace_prepare_failed','agent_dispatch_failed','runner_snapshot_missing','effective_definition_unresolved')
       OR fact.payload->>'reason' IN
        ('agent_workspace_prepare_failed','agent_dispatch_failed','runner_snapshot_missing','effective_definition_unresolved')))
    OR EXISTS(SELECT 1 FROM execution_commands command WHERE command.run_id=${source.id}
      AND command.kind='session.create' AND command.state='failed'
      AND command.receipt_evidence->>'phase'='rejected' AND command.receipt_evidence->>'inflight'='false')`);

  return proof.rows.length ? null : "reconciliation_required";
}
