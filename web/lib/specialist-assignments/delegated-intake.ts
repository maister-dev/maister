import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ResolvedAssignmentContextPrincipal } from "./context-access";
import type {
  AssignmentWorkSelector,
  PreparedAssignmentWork,
  SpecialistWorkRecord,
} from "./work-types";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  authorizeAssignmentDelegation,
  resolveAssignmentContextPrincipal,
} from "./context-access";
import { assertAssignmentAppointment } from "./appointment";
import { admitAssignmentWorkBudget } from "./delegated-budget";
import {
  readAuthorizedAssignmentInput,
  readSpecialistAssignmentContextInTransaction,
} from "./context";
import { assignmentAuthoritySnapshotSchema } from "./input-snapshot";
import { beginAssignmentTransaction, unavailableAssignment } from "./store";
import {
  assignmentObjectiveInputSchema,
  SPECIALIST_ASSIGNMENT_STATUSES,
} from "./types";
import {
  assignmentWorkBoundsSchema,
  assignmentWorkDefinitionSchema,
  assignmentWorkSelectorSchema,
  assignmentWorkTargetSchema,
  logicalWorkIdSchema,
  SPECIALIST_WORK_DECISION_STATES,
} from "./work-types";

import { knowledgeOwner } from "@/lib/brain/knowledge-access";
import { additionalKnowledgeRestrictions } from "@/lib/brain/knowledge-disclosure";
import { recordNativeRunSourcesInTransaction } from "@/lib/brain/knowledge-execution-access";
import { knowledgeActorSchema } from "@/lib/brain/knowledge-read-types";
import { inspectKnowledgeEvidenceReference } from "@/lib/brain/knowledge-reference";
import {
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
} from "@/lib/brain/knowledge-restrictions";
import { knowledgeRestrictionsSchema } from "@/lib/company/types";
import { pgErrorOf } from "@/lib/db/pg-error";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { emitSpecialistAssignmentChange } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import {
  admitDelegatedChild,
  lockDelegationParent,
} from "@/lib/orchestrator/admission";
import { parseBoundRunId } from "@/lib/tokens/verify";

const log = pino({
  name: "specialist-intake:delegated",
  level: process.env.LOG_LEVEL ?? "info",
});
const identity = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(1).max(2147483647);
const assignmentHeadSchema = z.object({
  revision,
  input_revision: revision,
  context_revision: z.number().int().min(0).max(2147483647),
  status: z.enum(SPECIALIST_ASSIGNMENT_STATUSES),
});

const retainedWorkSchema = z.object({
  id: identity,
  assignmentId: identity,
  logicalWorkId: logicalWorkIdSchema,
  inputRevision: revision,
  inputSha256: digest,
  workRevision: revision,
  revision,
  decisionState: z.enum(SPECIALIST_WORK_DECISION_STATES),
  definition: assignmentWorkDefinitionSchema,
  definitionSha256: digest,
  requestSha256: digest,
  sourceKey: digest,
  actor: knowledgeActorSchema,
  authoritySnapshot: assignmentAuthoritySnapshotSchema,
  bounds: assignmentWorkBoundsSchema,
  sourceRestrictions: knowledgeRestrictionsSchema,
  reservedRunId: identity,
  childRunId: identity.nullable(),
  createdAt: z.preprocess(databaseTimestamp, z.string().datetime()),
});

export type DelegatedWorkReceipt = Readonly<{
  work: SpecialistWorkRecord;
  duplicate: boolean;
}>;

export type DelegatedWorkRequest = Readonly<{
  tokenId: string;
  selector: AssignmentWorkSelector;
  prepared: PreparedAssignmentWork;
}>;
type DelegatedWorkOrigin = Readonly<{
  principal: ResolvedAssignmentContextPrincipal;
  source: Extract<
    ResolvedAssignmentContextPrincipal["source"],
    { kind: "execution" }
  >;
  consumer: NonNullable<ResolvedAssignmentContextPrincipal["consumer"]>;
  parentRunId: string;
  rootRunId: string;
  assignmentRow: Record<string, unknown>;
}>;

function decodeWork(
  row: Readonly<Record<string, unknown>>,
): SpecialistWorkRecord {
  const parsed = retainedWorkSchema.safeParse({
    id: row.id,
    assignmentId: row.assignment_id,
    logicalWorkId: row.logical_work_id,
    inputRevision: row.input_revision,
    inputSha256: row.input_sha256,
    workRevision: row.work_revision,
    revision: row.revision,
    decisionState: row.decision_state,
    definition: row.definition,
    definitionSha256: row.definition_sha256,
    requestSha256: row.request_sha256,
    sourceKey: row.source_key,
    actor: row.actor,
    authoritySnapshot: row.authority_snapshot,
    bounds: row.bounds,
    sourceRestrictions: row.source_restrictions,
    reservedRunId: row.reserved_run_id,
    childRunId: row.child_run_id,
    createdAt: row.created_at,
  });

  if (
    !parsed.success ||
    contentDigest(parsed.data.definition) !== parsed.data.definitionSha256
  )
    throw new MaisterError("CONFIG", "Retained delegated work is malformed");

  return parsed.data;
}

async function lockAssignmentForWork(
  tx: SqlTransaction,
  assignmentId: string,
): Promise<Record<string, unknown>> {
  try {
    const [row] = (
      await tx.execute(
        sql`SELECT company_id,project_id,revision,input_revision,context_revision,status FROM specialist_assignments WHERE id=${assignmentId} FOR UPDATE NOWAIT`,
      )
    ).rows;

    if (!row) throw unavailableAssignment();

    return row;
  } catch (error) {
    if (pgErrorOf(error)?.code !== "55P03") throw error;
    throw new MaisterError(
      "CONFLICT",
      "The assignment is being updated; retry the same work identity after it settles",
      { details: { reason: "assignment_work_busy" } },
    );
  }
}

function workConflict(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "This logical work identity already belongs to a different request",
    { details: { reason: "specialist_intake_payload_conflict" } },
  );
}

async function lockDelegatedWorkOrigin(
  tx: SqlTransaction,
  tokenId: string,
  assignmentId: string,
): Promise<DelegatedWorkOrigin> {
  // The unlocked token name locates the Run. Scope and binding are rechecked
  // after the root-to-parent lock order has been established.
  const [locator] = (
    await tx.execute(sql`
      SELECT name FROM project_tokens
      WHERE id=${tokenId} AND token_kind IN ('agent','project')
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
        AND (scopes ? '*' OR scopes ?& ARRAY['assignments:read','assignments:update'])
    `)
  ).rows;
  const parentRunId =
    typeof locator?.name === "string" ? parseBoundRunId(locator.name) : null;

  if (parentRunId === null)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Delegated work requires a current execution credential",
    );
  const rootRunId = await lockDelegationParent(tx, parentRunId);

  await assertAssignmentAppointment(tx, parentRunId, assignmentId);
  // Company identity resolution locks the same assignment for reading.
  // Take the non-waiting write fence before that resolution.
  const assignmentRow = await lockAssignmentForWork(tx, assignmentId);
  const principal = await resolveAssignmentContextPrincipal(
    tx,
    { kind: "token", tokenId },
    "assignments:update",
  );
  const { source, consumer } = principal;

  if (source.kind !== "execution" || source.runId !== parentRunId || !consumer)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Delegated work requires the current originating execution",
    );

  return { principal, source, consumer, parentRunId, rootRunId, assignmentRow };
}

/** Retain an authorized work definition and its canonical intake receipt under the existing tree fences. */
export async function retainDelegatedWorkInTransaction(
  tx: SqlTransaction,
  input: DelegatedWorkRequest,
): Promise<DelegatedWorkReceipt> {
  const selector = assignmentWorkSelectorSchema.parse(input.selector);
  const { assignmentId, logicalWorkId, workRevision, inputRevision } = selector;
  const objectiveInput = assignmentObjectiveInputSchema.parse(
    input.prepared.objectiveInput,
  );
  const target = assignmentWorkTargetSchema.parse(input.prepared.target);
  const bounds = assignmentWorkBoundsSchema.parse(input.prepared.bounds);
  const restrictions = knowledgeRestrictionsSchema.parse(
    input.prepared.sourceRestrictions,
  );
  const sourceKey = contentDigest({
    schemaVersion: 1,
    assignmentId,
    inputRevision,
    logicalWorkId,
    workRevision,
  });
  const requestSha256 = contentDigest({
    sourceKey,
    contextRevision: selector.contextRevision,
    objectiveInput,
    target,
    bounds,
  });

  await beginAssignmentTransaction(tx);
  const {
    principal,
    source,
    consumer,
    parentRunId,
    rootRunId,
    assignmentRow: row,
  } = await lockDelegatedWorkOrigin(tx, input.tokenId, assignmentId);
  const owner = knowledgeOwner(row);
  const head = assignmentHeadSchema.parse(row);
  const selectedInput = await readAuthorizedAssignmentInput(
    tx,
    source,
    assignmentId,
    inputRevision,
  );
  const authority = await authorizeAssignmentDelegation(
    tx,
    principal,
    owner,
    selectedInput.snapshot.authoritySnapshot.executionPolicy,
  );
  const [retained] = (
    await tx.execute(
      sql`SELECT work.* FROM specialist_work work JOIN specialist_intake_receipts receipt
        ON receipt.work_id=work.id AND receipt.work_revision=work.work_revision
        WHERE work.assignment_id=${assignmentId} AND work.logical_work_id=${logicalWorkId} AND work.work_revision=${workRevision}
          AND receipt.disposition='delegated' FOR SHARE OF work,receipt`,
    )
  ).rows;
  const [receivingBinding] = (
    await tx.execute(
      sql`SELECT specialist_work_target_exists(${JSON.stringify(target)}::jsonb,${row.company_id},${row.project_id}) AS available`,
    )
  ).rows;

  if (retained) {
    const work = decodeWork(retained);

    if (
      work.definition.parent.runId !== parentRunId ||
      work.actor.id !== authority.actor.id
    )
      throw unavailableAssignment();
    await authorizeSourceRestrictions(tx, source, work.sourceRestrictions);
    if (work.sourceKey !== sourceKey || work.requestSha256 !== requestSha256)
      throw workConflict();
    if (receivingBinding?.available !== true)
      throw new MaisterError(
        "PRECONDITION",
        "The retained receiving binding is unavailable",
      );
    log.info(
      {
        assignmentId,
        rootRunId,
        parentRunId,
        workId: work.id,
        workRevision,
        disposition: "duplicate",
      },
      "delegated intake adopted retained work",
    );

    return { work, duplicate: true };
  }
  if (
    head.revision !== selector.expectedRevision ||
    head.revision === 2147483647 ||
    head.input_revision !== inputRevision ||
    head.context_revision !== selector.contextRevision
  )
    throw new MaisterError(
      "CONFLICT",
      "Delegated work requires the current assignment, input, and context heads",
      {
        details: { reason: "assignment_revision_conflict" },
      },
    );
  const [running] = (
    await tx.execute(
      sql`SELECT 1 FROM runs WHERE id=${parentRunId} AND status='Running'`,
    )
  ).rows;

  if (
    !running ||
    !["active", "waiting_children"].includes(head.status) ||
    workRevision !== 1 ||
    receivingBinding?.available !== true
  )
    throw new MaisterError(
      "PRECONDITION",
      "New work requires a running responsible professional, current receiving binding, and initial work revision",
    );
  const effectiveBounds = await admitAssignmentWorkBudget(tx, {
    assignmentId,
    parentRunId,
    rootRunId,
    requested: bounds,
  });

  await admitDelegatedChild(tx, {
    parentRunId,
    assignmentBounds: effectiveBounds,
  });
  const { value: context, access } =
    await readSpecialistAssignmentContextInTransaction(
      tx,
      source,
      assignmentId,
    );
  let sourceAccess = await authorizeSourceRestrictions(
    tx,
    source,
    [...consumer.capture.restrictions, ...restrictions],
    access,
  );

  for (const reference of objectiveInput.inputRefs)
    sourceAccess = await inspectKnowledgeEvidenceReference(
      tx,
      source,
      reference,
      sourceAccess,
    );
  const sourceRestrictions = additionalKnowledgeRestrictions(
    owner,
    restrictionsForKnowledgeAccess(sourceAccess),
  );
  const definition = {
    schemaVersion: 1,
    objectiveInput,
    target,
    context: {
      revision: context.revision,
      inputRevision: context.inputRevision,
      inputSha256: context.inputSha256,
      contentSha256: context.digest,
    },
    parent: {
      rootRunId,
      runId: parentRunId,
      nodeAttemptId: source.nodeAttemptId,
    },
  };
  const definitionSha256 = contentDigest(definition);
  const actor = authority.actor;
  const reservedRunId = randomUUID();
  const [inserted] = (
    await tx.execute(sql`INSERT INTO specialist_work(work_revision,assignment_id,input_revision,input_sha256,logical_work_id,parent_run_id,definition,definition_sha256,actor,authority_snapshot,bounds,source_restrictions,request_sha256,source_key,reserved_run_id)
      VALUES(${workRevision},${assignmentId},${inputRevision},${selectedInput.digest},${logicalWorkId},${parentRunId},${JSON.stringify(definition)}::jsonb,${definitionSha256},${JSON.stringify(actor)}::jsonb,${JSON.stringify(authority)}::jsonb,${JSON.stringify(effectiveBounds)}::jsonb,${JSON.stringify(sourceRestrictions)}::jsonb,${requestSha256},${sourceKey},${reservedRunId}) RETURNING *`)
  ).rows;

  if (!inserted || actor.kind !== "agent" || actor.id === null)
    throw new MaisterError(
      "CRASH",
      "Delegated intake did not retain its originating work",
    );
  const work = decodeWork(inserted);

  await tx.execute(sql`INSERT INTO specialist_intake_receipts(source_kind,source_key,request_digest,assignment_id,input_revision,actor,disposition,work_id,work_revision)
    VALUES('delegation',${sourceKey},${requestSha256},${assignmentId},${inputRevision},${JSON.stringify(actor)}::jsonb,'delegated',${work.id},${workRevision})`);
  await tx.execute(
    sql`UPDATE specialist_assignments SET revision=revision+1,updated_at=clock_timestamp() WHERE id=${assignmentId}`,
  );
  await emitSpecialistAssignmentChange({
    db: tx,
    owner,
    assignmentId,
    revision: head.revision + 1,
    previousStatus: head.status,
    status: head.status,
    cause: "work",
    actor: { type: "agent", id: actor.id },
    originExecution: {
      runId: parentRunId,
      nodeAttemptId: source.nodeAttemptId,
    },
  });
  log.info(
    {
      assignmentId,
      rootRunId,
      parentRunId,
      workId: work.id,
      workRevision,
      bounds: effectiveBounds,
      disposition: "delegated",
    },
    "delegated intake retained one work reservation",
  );

  return { work, duplicate: false };
}

/** Bind the exact reserved child and its source closure in the Run allocation transaction. */
export async function bindDelegatedWorkRunInTransaction(
  tx: SqlTransaction,
  work: SpecialistWorkRecord,
): Promise<void> {
  const {
    id,
    assignmentId,
    workRevision,
    revision,
    definitionSha256,
    reservedRunId,
  } = work;

  await admitAssignmentWorkBudget(tx, {
    assignmentId,
    parentRunId: work.definition.parent.runId,
    rootRunId: work.definition.parent.rootRunId,
    requested: work.bounds,
    reservedRunId,
  });
  const [bound] = (
    await tx.execute(sql`
      UPDATE specialist_work SET child_run_id=${reservedRunId}, revision=revision+1
      WHERE id=${id} AND assignment_id=${assignmentId} AND work_revision=${workRevision}
        AND revision=${revision} AND definition_sha256=${definitionSha256}
        AND reserved_run_id=${reservedRunId} AND child_run_id IS NULL AND decision_state='open'
        AND EXISTS (SELECT 1 FROM runs child WHERE child.id=${reservedRunId}
          AND child.knowledge_access->>'state'='complete'
          AND (child.run_kind<>'flow' OR child.knowledge_access->'restrictions' @> ${JSON.stringify(work.sourceRestrictions)}::jsonb))
      RETURNING input_revision
    `)
  ).rows;

  if (!bound || bound.input_revision !== work.inputRevision)
    throw new MaisterError(
      "CONFLICT",
      "Delegated work no longer owns the reserved Run",
      {
        details: { reason: "delegated_work_binding_changed" },
      },
    );
  const witness = { schemaVersion: 1, id, workRevision, definitionSha256 };

  await tx.execute(sql`
    INSERT INTO specialist_run_links(run_id,assignment_id,input_revision,role,work_id,work_revision,work_witness)
    VALUES(${reservedRunId},${assignmentId},${work.inputRevision},'child',${id},${workRevision},${JSON.stringify(witness)}::jsonb)
  `);
  if (work.definition.target.kind !== "company_flow")
    await recordNativeRunSourcesInTransaction(
      tx,
      reservedRunId,
      work.sourceRestrictions,
    );
  log.debug(
    {
      assignmentId,
      parentRunId: work.definition.parent.runId,
      workId: id,
      workRevision,
      childRunId: reservedRunId,
    },
    "delegated Run and authorized source closure bound",
  );
}
