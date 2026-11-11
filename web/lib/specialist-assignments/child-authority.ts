import "server-only";

import type { KnowledgeRecipient } from "@/lib/brain/knowledge-run-disclosure";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { Owner } from "@/lib/company/types";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { ResolvedAssignmentContextPrincipal } from "./context-access";

import { sql } from "drizzle-orm";

import {
  authorizeAssignmentDelegation,
  resolveAssignmentContextPrincipal,
} from "./context-access";
import { readAuthorizedAssignmentInput } from "./context";

import { knowledgeOwner } from "@/lib/brain/knowledge-access";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { MaisterError } from "@/lib/errors";

type ChildAuthorityInput = Readonly<{
  parentRunId: string;
  childRunId: string;
  recipient: KnowledgeRecipient;
}>;
export type CollectedWorkRevision = Readonly<{
  id: string;
  assignmentId: string;
  workRevision: number;
  inputRevision: number;
  revision: number;
}>;
type ChildAuthority = Readonly<{
  principal: ResolvedAssignmentContextPrincipal;
  owner: Owner;
  policy: ExecutionPolicy;
  work: CollectedWorkRevision;
}>;

function unavailableChild(): MaisterError {
  return new MaisterError(
    "UNAUTHORIZED",
    "Native child work requires its current originating professional",
    {
      details: { reason: "delegated_work_origin_required" },
    },
  );
}

async function currentNativeChild(
  tx: SqlTransaction,
  { childRunId, parentRunId, recipient }: ChildAuthorityInput,
): Promise<ChildAuthority | null> {
  const [retained] = (
    await tx.execute(
      sql`SELECT id FROM specialist_work WHERE reserved_run_id=${childRunId}`,
    )
  ).rows;

  if (!retained) return null;
  if (recipient.kind !== "token") throw unavailableChild();
  const principal = await resolveAssignmentContextPrincipal(
    tx,
    recipient,
    "assignments:read",
  );

  if (
    principal.source.kind !== "execution" ||
    principal.source.runId !== parentRunId
  )
    throw unavailableChild();
  const [work] = (
    await tx.execute(sql`
      SELECT work.id, work.assignment_id, work.input_revision, work.work_revision,
        work.revision, work.source_restrictions,
        assignment.project_id, assignment.company_id
      FROM specialist_work work
      JOIN specialist_assignments assignment ON assignment.id=work.assignment_id
      JOIN runs child ON child.id=work.child_run_id AND child.parent_run_id=work.parent_run_id
        AND child.project_id IS NOT DISTINCT FROM assignment.project_id
        AND child.company_id IS NOT DISTINCT FROM assignment.company_id
      WHERE work.reserved_run_id=${childRunId} AND child.id=${childRunId}
        AND work.parent_run_id=${parentRunId} AND work.actor->>'id'=${principal.identity.actor.id}
        AND work.decision_state<>'cancelled'
        AND specialist_run_has_input(child.id,work.assignment_id,work.input_revision,work.input_sha256)
        AND specialist_work_target_exists(work.definition->'target',assignment.company_id,assignment.project_id)
      FOR SHARE OF work,assignment
    `)
  ).rows;

  if (
    typeof work?.id !== "string" ||
    typeof work.assignment_id !== "string" ||
    typeof work.input_revision !== "number" ||
    typeof work.work_revision !== "number" ||
    typeof work.revision !== "number"
  )
    throw unavailableChild();
  const input = await readAuthorizedAssignmentInput(
    tx,
    principal.source,
    work.assignment_id,
    work.input_revision,
  );

  await authorizeSourceRestrictions(
    tx,
    principal.source,
    work.source_restrictions,
  );

  return {
    principal,
    owner: knowledgeOwner(work),
    policy: input.snapshot.authoritySnapshot.executionPolicy,
    work: {
      id: work.id,
      assignmentId: work.assignment_id,
      inputRevision: work.input_revision,
      workRevision: work.work_revision,
      revision: work.revision,
    },
  };
}

/** The result and its first-collected marker require the same originating professional. */
export async function authorizeNativeChildCollection(
  tx: SqlTransaction,
  input: ChildAuthorityInput,
): Promise<CollectedWorkRevision> {
  const current = await currentNativeChild(tx, input);

  if (!current) throw unavailableChild();

  return current.work;
}

/** Messaging and rework reuse the existing delegation authority before transferring private input. */
export async function authorizeNativeChildInput(
  tx: SqlTransaction,
  input: ChildAuthorityInput,
): Promise<boolean> {
  const child = await currentNativeChild(tx, input);

  if (!child) return false;
  await authorizeAssignmentDelegation(
    tx,
    child.principal,
    child.owner,
    child.policy,
  );

  return true;
}
