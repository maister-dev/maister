import "server-only";

import type { KnowledgePrincipal } from "@/lib/brain/knowledge-types";
import type { KnowledgeAccessWalk } from "@/lib/brain/knowledge-restrictions";
import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type {
  PreparedSpecialistAssignment,
  SpecialistAssignment,
  AssignmentInputSnapshot,
  AssignmentInputUpdate,
  AssignmentInputRevision,
  AssignmentStateReceipt,
  SpecialistRunLinkInput,
} from "./types";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import pino from "pino";

import { authorizeAssignment } from "./access";
import { assertAssignmentAppointment } from "./appointment";
import { validateAssignmentDestination } from "./destination";
import {
  assignmentDestinationSchema,
  assignmentObjectiveInputSchema,
  assignmentOriginSchema,
  assignmentInputUpdateSchema,
  specialistAssignmentSchema,
  specialistRunLinkInputSchema,
} from "./types";
import { decodeAssignmentInput, retainAssignmentInput } from "./input-snapshot";
import { assertProjectCoordinatorProvider } from "./project-flow-provider";

import { companyExecutionSnapshotSchema } from "@/lib/agents/company-execution-types";
import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { parseAgentDefinition } from "@/lib/agents/definition";
import { parseScheduledRequestSnapshot } from "@/lib/agents/scheduled-request";
import { knowledgeOwner } from "@/lib/brain/knowledge-access";
import {
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
} from "@/lib/brain/knowledge-restrictions";
import { inspectKnowledgeEvidenceReference } from "@/lib/brain/knowledge-reference";
import { validateInstanceConfig } from "@/lib/agents/config";
import { knowledgeRestrictionsSchema, ownerSchema } from "@/lib/company/types";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { redactQueryError } from "@/lib/db/pg-error";
import { emitSpecialistAssignmentChange } from "@/lib/domain-events/outbox";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import { isTerminalRunStatus } from "@/lib/runs/run-status-sets";
import { postgresTextSchema } from "@/lib/text-schema";

const log = pino({
  name: "specialist-assignments:store",
  level: process.env.LOG_LEVEL ?? "info",
});
const identitySchema = postgresTextSchema.min(1).max(128);

export async function beginAssignmentTransaction(
  tx: SqlTransaction,
): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
  await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
}

export function unavailableAssignment(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Specialist assignment reference is unavailable",
    { details: { reason: "assignment_reference_unavailable" } },
  );
}

async function validateStandingDefinition(
  tx: SqlTransaction,
  input: PreparedSpecialistAssignment,
): Promise<void> {
  const standing = input.standingDefinition;
  const role = /^([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+)$/.exec(
    input.responsibleAgentId,
  );

  if (
    !role ||
    (standing.schemaVersion !== 1 && standing.schemaVersion !== 2) ||
    standing.agentId !== input.responsibleAgentId ||
    standing.packageName !== role[1]
  )
    throw new MaisterError(
      "CONFIG",
      "Assignment responsibility must identify its exact pinned specialist definition",
    );
  const pin = (
    await tx.execute(
      sql`SELECT name,resolved_revision,installed_path,trust_status,package_status FROM package_installs WHERE id=${standing.packageInstallId} FOR SHARE`,
    )
  ).rows[0];

  if (
    !pin ||
    pin.name !== standing.packageName ||
    pin.resolved_revision !== standing.packageRevision ||
    pin.package_status !== "Installed" ||
    (pin.trust_status !== "trusted" &&
      pin.trust_status !== "trusted_by_policy") ||
    typeof pin.installed_path !== "string"
  )
    throw new MaisterError(
      "PRECONDITION",
      "Assignment specialist package pin is unavailable or untrusted",
    );
  let content: string;

  try {
    content = await readFile(
      join(pin.installed_path, "maister-agents", `${role[2]}.md`),
      "utf8",
    );
  } catch (error) {
    throw new MaisterError(
      "PRECONDITION",
      "Pinned specialist definition cannot be read; repair or reinstall its exact package",
      {
        cause: error instanceof Error ? error : undefined,
        details: {
          reason: "assignment_standing_definition_unavailable",
          packageInstallId: standing.packageInstallId,
          packageRevision: standing.packageRevision,
          agentId: input.responsibleAgentId,
        },
      },
    );
  }
  const definition = parseAgentDefinition(input.responsibleAgentId, content);

  if (
    agentDefinitionSha256(definition) !== standing.definitionSha256 ||
    agentDefinitionSha256(standing.definition) !== standing.definitionSha256
  )
    throw new MaisterError(
      "CONFLICT",
      "Assignment standing definition differs from its immutable installed pin",
    );
  const configurationError = validateInstanceConfig(
    definition.config,
    standing.configuration ?? {},
  );

  if (configurationError) throw new MaisterError("CONFIG", configurationError);
  if (standing.schemaVersion === 2) {
    if (
      input.owner.kind !== "project" ||
      standing.definition.flow !== standing.coordinatorFlow.flowRefId
    )
      throw new MaisterError(
        "CONFIG",
        "An exact project coordinator witness requires its project owner and declared Flow",
      );
    await assertProjectCoordinatorProvider(
      tx,
      input.owner.projectId,
      standing.coordinatorFlow,
    );
  }
}

/** Shared projection keeps human and executing principals distinct throughout source authorization. */
async function inspectAssignmentInTransaction(
  tx: SqlTransaction,
  principal: Extract<KnowledgePrincipal, { kind: "user" | "execution" }>,
  assignmentId: string,
): Promise<
  Readonly<{ value: SpecialistAssignment; access: KnowledgeAccessWalk }>
> {
  if (!identitySchema.safeParse(assignmentId).success)
    throw new MaisterError("CONFIG", "Invalid assignment identity");
  if (principal.kind === "execution")
    await assertAssignmentAppointment(tx, principal.runId, assignmentId);
  const head = (
    await tx.execute(
      sql`SELECT * FROM specialist_assignments WHERE id=${assignmentId} FOR SHARE`,
    )
  ).rows[0];

  if (!head) throw unavailableAssignment();
  if (principal.kind === "user")
    await authorizeAssignment(
      tx,
      principal.userId,
      knowledgeOwner(head),
      "assignments:read",
      { preset: "supervised" },
    );
  const input = (
    await tx.execute(
      sql`SELECT objective_input,source_restrictions,digest FROM specialist_input_revisions WHERE assignment_id=${assignmentId} AND revision=${head.input_revision} FOR SHARE`,
    )
  ).rows[0];

  if (!input)
    throw new MaisterError(
      "CONFIG",
      "Assignment input head is missing; inspect migration and transaction integrity",
    );
  const access = await authorizeSourceRestrictions(tx, principal, [
    ...knowledgeRestrictionsSchema.parse(input.source_restrictions),
    {
      kind: "assignment_input",
      assignmentId,
      inputRevision: Number(head.input_revision),
      inputSha256: String(input.digest),
    },
  ]);
  const objective = assignmentObjectiveInputSchema.safeParse(
    input.objective_input,
  );

  if (!objective.success)
    throw new MaisterError(
      "CONFIG",
      "Stored assignment input does not match its versioned contract",
    );
  const links = (
    await tx.execute(
      sql`SELECT run_id FROM specialist_run_links WHERE assignment_id=${assignmentId} ORDER BY linked_at,run_id`,
    )
  ).rows;
  const value = specialistAssignmentSchema.safeParse({
    id: head.id,
    revision: head.revision,
    owner: knowledgeOwner(head),
    objective: objective.data.objective,
    expectedOutcome: objective.data.expectedOutcome,
    requester: head.requester,
    responsible: head.responsible,
    specialistBindingId: head.specialist_binding_id,
    inputRevision: head.input_revision,
    contextRevision: head.context_revision,
    status: head.status,
    targetIds: objective.data.targetIds,
    inputRefs: objective.data.inputRefs,
    constraints: objective.data.constraints,
    expectedResult: objective.data.expectedResult,
    verification: objective.data.verification,
    origin: head.origin,
    destination: head.destination,
    runIds: links.map((row) => row.run_id),
    blockers: head.blockers,
    acceptedResult: null,
    createdAt: databaseTimestamp(head.created_at),
    updatedAt: databaseTimestamp(head.updated_at),
  });

  if (!value.success)
    throw new MaisterError(
      "CONFIG",
      "Stored assignment does not match its native read contract",
    );

  return { value: value.data, access };
}

/** Human reads retain current owner and inherited-source authorization. */
export async function getSpecialistAssignmentInTransaction(
  tx: SqlTransaction,
  userId: string,
  assignmentId: string,
): Promise<SpecialistAssignment> {
  return (
    await inspectAssignmentInTransaction(
      tx,
      { kind: "user", userId },
      assignmentId,
    )
  ).value;
}

/** Execution reads require their exact appointment and current input/source policy. */
export async function inspectExecutingAssignmentInTransaction(
  tx: SqlTransaction,
  principal: Extract<KnowledgePrincipal, { kind: "execution" }>,
  assignmentId: string,
): Promise<
  Readonly<{ value: SpecialistAssignment; access: KnowledgeAccessWalk }>
> {
  return inspectAssignmentInTransaction(tx, principal, assignmentId);
}

export async function getSpecialistAssignment(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
): Promise<SpecialistAssignment> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);

      return getSpecialistAssignmentInTransaction(tx, userId, assignmentId);
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Intake owners compose this write and their existing delivery receipt in one transaction. */
export async function createSpecialistAssignmentInTransaction(
  tx: SqlTransaction,
  userId: string,
  input: PreparedSpecialistAssignment,
): Promise<SpecialistAssignment> {
  const objectiveInput = assignmentObjectiveInputSchema.safeParse(
    input.objectiveInput,
  );
  const owner = ownerSchema.safeParse(input.owner);
  const origin = assignmentOriginSchema.safeParse(input.origin);
  const destination = assignmentDestinationSchema.safeParse(input.destination);
  const restrictions = knowledgeRestrictionsSchema.safeParse(
    input.sourceRestrictions,
  );
  const policy = executionPolicySchema.safeParse(input.executionPolicy);

  if (
    !objectiveInput.success ||
    !owner.success ||
    !origin.success ||
    !destination.success ||
    !restrictions.success ||
    !policy.success ||
    !identitySchema.safeParse(input.specialistBindingId).success
  )
    throw new MaisterError(
      "CONFIG",
      "Invalid server-prepared specialist assignment input",
    );
  const authoritySnapshot = await authorizeAssignment(
    tx,
    userId,
    owner.data,
    "assignments:submit",
    policy.data,
  );

  await authorizeAssignment(
    tx,
    userId,
    owner.data,
    "assignments:read",
    policy.data,
  );
  await validateAssignmentDestination(tx, userId, owner.data, destination.data);
  let access = await authorizeSourceRestrictions(
    tx,
    { kind: "user", userId },
    restrictions.data,
  );

  for (const reference of objectiveInput.data.inputRefs)
    access = await inspectKnowledgeEvidenceReference(
      tx,
      { kind: "user", userId },
      reference,
      access,
    );
  await validateStandingDefinition(tx, input);
  const scheduledRequest = parseScheduledRequestSnapshot(
    input.scheduledRequest,
  );

  if (
    (origin.data.kind === "schedule" &&
      (scheduledRequest === null ||
        scheduledRequest.scheduleId !== origin.data.scheduleId ||
        scheduledRequest.triggerAttemptId !== origin.data.triggerAttemptId)) ||
    (origin.data.kind !== "schedule" && scheduledRequest !== null)
  )
    throw new MaisterError(
      "CONFIG",
      "Recurring request snapshot must identify this assignment's exact scheduled invocation",
    );
  const snapshot: AssignmentInputSnapshot = {
    schemaVersion: 1,
    objectiveInput: objectiveInput.data,
    standingDefinition: input.standingDefinition,
    scheduledRequest,
    authoritySnapshot,
    sourceRestrictions: restrictionsForKnowledgeAccess(access),
  };
  const responsible = {
    kind: "agent",
    id: input.responsibleAgentId,
    runId: null,
    attemptId: null,
  };
  const head = (
    await tx.execute(
      sql`INSERT INTO specialist_assignments(company_id,project_id,specialist_binding_id,requester,responsible,origin,destination) VALUES(${owner.data.kind === "company" ? owner.data.companyId : null},${owner.data.kind === "project" ? owner.data.projectId : null},${input.specialistBindingId},${JSON.stringify(authoritySnapshot.actor)}::jsonb,${JSON.stringify(responsible)}::jsonb,${JSON.stringify(origin.data)}::jsonb,${JSON.stringify(destination.data)}::jsonb) RETURNING id`,
    )
  ).rows[0];

  if (!head || typeof head.id !== "string")
    throw new MaisterError(
      "CRASH",
      "Assignment creation did not retain its identity",
    );
  await retainAssignmentInput(tx, head.id, 1, snapshot);
  await emitSpecialistAssignmentChange({
    db: tx,
    owner: owner.data,
    assignmentId: head.id,
    revision: 1,
    previousStatus: null,
    status: "queued",
    cause: "created",
    actor: { type: "user", id: userId },
  });
  log.info(
    {
      assignmentId: head.id,
      ownerKind: owner.data.kind,
      revision: 1,
      inputRevision: 1,
      authorityIds: authoritySnapshot.witnesses.map((witness) =>
        witness.kind === "company_grant"
          ? witness.authorityId
          : witness.kind === "project_membership"
            ? witness.membershipId
            : witness.userId,
      ),
      definitionSha256: input.standingDefinition.definitionSha256,
    },
    "specialist assignment created",
  );

  return getSpecialistAssignmentInTransaction(tx, userId, head.id);
}

export async function createSpecialistAssignment(
  db: SqlDatabase,
  userId: string,
  input: PreparedSpecialistAssignment,
): Promise<SpecialistAssignment> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);

      return createSpecialistAssignmentInTransaction(tx, userId, input);
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Historical bytes remain inspectable only under current assignment and inherited-source access. */
export async function getSpecialistAssignmentInputInTransaction(
  tx: SqlTransaction,
  userId: string,
  assignmentId: string,
  revision: number,
): Promise<AssignmentInputRevision> {
  const assignment = await getSpecialistAssignmentInTransaction(
    tx,
    userId,
    assignmentId,
  );

  if (!Number.isInteger(revision) || revision < 1 || revision > 2147483647)
    throw new MaisterError(
      "CONFIG",
      "Select an exact positive assignment input revision",
    );
  if (revision > assignment.inputRevision) throw unavailableAssignment();
  const row = (
    await tx.execute(
      sql`SELECT * FROM specialist_input_revisions WHERE assignment_id=${assignmentId} AND revision=${revision} FOR SHARE`,
    )
  ).rows[0];

  if (!row) throw unavailableAssignment();
  await authorizeSourceRestrictions(
    tx,
    { kind: "user", userId },
    row.source_restrictions,
  );

  return decodeAssignmentInput(row);
}

export async function getSpecialistAssignmentInput(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  revision: number,
): Promise<AssignmentInputRevision> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);

      return getSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        assignmentId,
        revision,
      );
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Parent locking serializes input changes with context, work and ownership writers. */
export async function lockSpecialistAssignment(
  tx: SqlTransaction,
  assignmentId: string,
  expectedRevision: number,
): Promise<Readonly<Record<string, unknown>>> {
  if (
    !identitySchema.safeParse(assignmentId).success ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 1 ||
    expectedRevision > 2147483647
  )
    throw new MaisterError(
      "CONFIG",
      "Assignment changes require a valid identity and an unexhausted exact business revision",
    );
  const head = await lockAssignmentHead(tx, assignmentId);

  if (head.revision !== expectedRevision || head.revision === 2147483647)
    throw new MaisterError(
      "CONFLICT",
      "Assignment changed or its business revision is exhausted; inspect the current assignment before continuing",
      { details: { reason: "assignment_revision_conflict" } },
    );

  return head;
}

async function lockAssignmentHead(
  tx: SqlTransaction,
  assignmentId: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (!identitySchema.safeParse(assignmentId).success)
    throw new MaisterError("CONFIG", "Invalid assignment identity");
  const head = (
    await tx.execute(
      sql`SELECT * FROM specialist_assignments WHERE id=${assignmentId} FOR UPDATE`,
    )
  ).rows[0];

  if (!head) throw unavailableAssignment();

  return head;
}

async function assertNoUnsettledAssignmentRuns(
  tx: SqlTransaction,
  assignmentId: string,
): Promise<void> {
  const runs = (
    await tx.execute(
      sql`SELECT execution.id,execution.status FROM runs execution JOIN specialist_run_links link ON link.run_id=execution.id WHERE link.assignment_id=${assignmentId} ORDER BY execution.id FOR SHARE OF execution`,
    )
  ).rows;

  if (runs.some((run) => !isTerminalRunStatus(String(run.status))))
    throw new MaisterError(
      "CONFLICT",
      "Stop or settle linked execution before changing assignment input or terminal state",
      { details: { reason: "assignment_execution_unsettled" } },
    );
}

export async function appendSpecialistAssignmentInputInTransaction(
  tx: SqlTransaction,
  userId: string,
  assignmentId: string,
  input: AssignmentInputUpdate,
): Promise<SpecialistAssignment> {
  const request = assignmentInputUpdateSchema.safeParse(input);

  if (!request.success)
    throw new MaisterError(
      "CONFIG",
      "Invalid exact-revision assignment input update",
    );
  const head = await lockSpecialistAssignment(
    tx,
    assignmentId,
    request.data.expectedRevision,
  );
  const current = await getSpecialistAssignmentInputInTransaction(
    tx,
    userId,
    assignmentId,
    Number(head.input_revision),
  );
  const authoritySnapshot = await authorizeAssignment(
    tx,
    userId,
    knowledgeOwner(head),
    "assignments:update",
    current.snapshot.authoritySnapshot.executionPolicy,
  );

  if (head.status !== "queued" && head.status !== "waiting_input")
    throw new MaisterError(
      "CONFLICT",
      "Assignment input can change only while queued or waiting for input",
      { details: { reason: "assignment_input_state_conflict" } },
    );
  await assertNoUnsettledAssignmentRuns(tx, assignmentId);
  const inputRefs = [
    ...new Map(
      [
        ...current.snapshot.objectiveInput.inputRefs,
        ...request.data.references,
      ].map((reference) => [contentDigest(reference), reference]),
    ).values(),
  ];
  const objectiveInput = assignmentObjectiveInputSchema.safeParse({
    ...current.snapshot.objectiveInput,
    input: [current.snapshot.objectiveInput.input, request.data.input]
      .filter(Boolean)
      .join("\n\n"),
    inputRefs,
  });

  if (!objectiveInput.success)
    throw new MaisterError(
      "PRECONDITION",
      "Combined assignment input exceeds its text or reference bounds; submit separate work",
    );
  let access = await authorizeSourceRestrictions(
    tx,
    { kind: "user", userId },
    current.snapshot.sourceRestrictions,
  );

  for (const reference of request.data.references)
    access = await inspectKnowledgeEvidenceReference(
      tx,
      { kind: "user", userId },
      reference,
      access,
    );
  const snapshot: AssignmentInputSnapshot = {
    ...current.snapshot,
    objectiveInput: objectiveInput.data,
    authoritySnapshot,
    sourceRestrictions: restrictionsForKnowledgeAccess(access),
  };
  const revision = current.revision + 1;

  if (revision > 2147483647)
    throw new MaisterError(
      "CONFLICT",
      "Assignment input revision is exhausted",
    );
  await retainAssignmentInput(tx, assignmentId, revision, snapshot);
  await tx.execute(
    sql`UPDATE specialist_assignments SET revision=revision+1,input_revision=${revision},updated_at=clock_timestamp() WHERE id=${assignmentId}`,
  );
  const status = specialistAssignmentSchema.shape.status.parse(head.status);

  await emitSpecialistAssignmentChange({
    db: tx,
    owner: knowledgeOwner(head),
    assignmentId,
    revision: request.data.expectedRevision + 1,
    previousStatus: status,
    status,
    cause: "input",
    actor: { type: "user", id: userId },
  });
  log.info(
    {
      assignmentId,
      revision: request.data.expectedRevision + 1,
      inputRevision: revision,
      actorId: userId,
    },
    "assignment input revision appended",
  );

  return getSpecialistAssignmentInTransaction(tx, userId, assignmentId);
}

export async function appendSpecialistAssignmentInput(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  input: AssignmentInputUpdate,
): Promise<SpecialistAssignment> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);

      return appendSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        assignmentId,
        input,
      );
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Cancellation records intent only after the execution owner has settled all linked work. */
export async function cancelSpecialistAssignment(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  expectedRevision: number,
  reason: string,
): Promise<AssignmentStateReceipt> {
  const parsedReason = postgresTextSchema
    .min(1)
    .max(2000)
    .regex(/\S/)
    .safeParse(reason);

  if (!parsedReason.success)
    throw new MaisterError(
      "CONFIG",
      "Cancellation requires a bounded, nonblank reason",
    );
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const head = await lockSpecialistAssignment(
        tx,
        assignmentId,
        expectedRevision,
      );

      await authorizeAssignment(
        tx,
        userId,
        knowledgeOwner(head),
        "assignments:cancel",
        { preset: "supervised" },
      );
      if (["completed", "failed", "cancelled"].includes(String(head.status)))
        throw new MaisterError(
          "CONFLICT",
          "Assignment is already terminal; inspect its retained outcome",
        );
      await assertNoUnsettledAssignmentRuns(tx, assignmentId);
      await tx.execute(
        sql`UPDATE specialist_assignments SET status='cancelled',revision=revision+1,terminal_reason=${parsedReason.data},updated_at=clock_timestamp() WHERE id=${assignmentId}`,
      );
      await emitSpecialistAssignmentChange({
        db: tx,
        owner: knowledgeOwner(head),
        assignmentId,
        revision: expectedRevision + 1,
        previousStatus: specialistAssignmentSchema.shape.status.parse(
          head.status,
        ),
        status: "cancelled",
        cause: "cancelled",
        actor: { type: "user", id: userId },
      });
      log.info(
        { assignmentId, revision: expectedRevision + 1, actorId: userId },
        "assignment cancellation retained",
      );

      return {
        assignmentId,
        revision: expectedRevision + 1,
        status: "cancelled",
      };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Reopening preserves the old state fact and inputs; it does not launch or repeat external effects. */
export async function recoverSpecialistAssignment(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  expectedRevision: number,
): Promise<AssignmentStateReceipt> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const head = await lockSpecialistAssignment(
        tx,
        assignmentId,
        expectedRevision,
      );

      await authorizeAssignment(
        tx,
        userId,
        knowledgeOwner(head),
        "assignments:recover",
        { preset: "supervised" },
      );
      if (head.status !== "failed" && head.status !== "cancelled")
        throw new MaisterError(
          "CONFLICT",
          "Only an explicitly failed or cancelled assignment can be reopened",
        );
      await assertNoUnsettledAssignmentRuns(tx, assignmentId);
      await tx.execute(
        sql`UPDATE specialist_assignments SET status='queued',revision=revision+1,terminal_reason=NULL,updated_at=clock_timestamp() WHERE id=${assignmentId}`,
      );
      await emitSpecialistAssignmentChange({
        db: tx,
        owner: knowledgeOwner(head),
        assignmentId,
        revision: expectedRevision + 1,
        previousStatus: head.status,
        status: "queued",
        cause: "recovered",
        actor: { type: "user", id: userId },
      });
      log.info(
        { assignmentId, revision: expectedRevision + 1, actorId: userId },
        "assignment recovery revision retained",
      );

      return { assignmentId, revision: expectedRevision + 1, status: "queued" };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Admission links its existing run and immutable input in the same transaction, without another attempt ledger. */
export async function linkSpecialistAssignmentRunInTransaction(
  tx: SqlTransaction,
  userId: string,
  assignmentId: string,
  input: SpecialistRunLinkInput,
): Promise<{ assignment: SpecialistAssignment; duplicate: boolean }> {
  const request = specialistRunLinkInputSchema.safeParse(input);

  if (!request.success)
    throw new MaisterError("CONFIG", "Invalid exact assignment execution link");
  const head = await lockAssignmentHead(tx, assignmentId);
  const owner = knowledgeOwner(head);

  await authorizeAssignment(tx, userId, owner, "assignments:update", {
    preset: "supervised",
  });
  await getSpecialistAssignmentInTransaction(tx, userId, assignmentId);
  const execution = (
    await tx.execute(
      sql`SELECT id,project_id,company_id,company_execution_snapshot FROM runs WHERE id=${request.data.runId} FOR UPDATE`,
    )
  ).rows[0];

  const companyCapture = companyExecutionSnapshotSchema.safeParse(
    execution?.company_execution_snapshot,
  );
  const ownerMatches =
    execution !== undefined &&
    (owner.kind === "project"
      ? execution.project_id === owner.projectId &&
        execution.company_id === null
      : execution.company_id === owner.companyId &&
        execution.project_id === null &&
        companyCapture.success &&
        companyCapture.data.owner.companyId === owner.companyId &&
        companyCapture.data.assignment.id === assignmentId &&
        companyCapture.data.assignment.inputRevision ===
          request.data.inputRevision &&
        companyCapture.data.specialistBinding.id ===
          head.specialist_binding_id &&
        (companyCapture.data.schemaVersion !== 2 ||
          request.data.role === "coordinator"));

  if (!ownerMatches)
    throw new MaisterError(
      "PRECONDITION",
      "Execution owner and immutable input must match the exact assignment admission",
    );
  const existing = (
    await tx.execute(
      sql`SELECT assignment_id,input_revision,role,work_id,work_revision FROM specialist_run_links WHERE run_id=${request.data.runId} FOR SHARE`,
    )
  ).rows[0];

  if (existing) {
    if (
      existing.assignment_id !== assignmentId ||
      existing.input_revision !== request.data.inputRevision ||
      existing.role !== request.data.role ||
      existing.work_id !== (request.data.work?.id ?? null) ||
      existing.work_revision !== (request.data.work?.revision ?? null)
    )
      throw new MaisterError(
        "CONFLICT",
        "Execution already has a different immutable assignment/input/work link",
      );

    return {
      assignment: await getSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
      ),
      duplicate: true,
    };
  }
  if (
    head.revision !== request.data.expectedRevision ||
    head.input_revision !== request.data.inputRevision ||
    Number(head.revision) >= 2147483647
  )
    throw new MaisterError(
      "CONFLICT",
      "Execution link requires the current assignment and input revisions",
    );
  if (["completed", "failed", "cancelled"].includes(String(head.status)))
    throw new MaisterError(
      "CONFLICT",
      "Terminal assignments cannot acquire new execution work",
    );
  if (!request.data.work && request.data.role !== "child") {
    const [ownership] = (
      await tx.execute(sql`
        SELECT specialist_root_link_conflicts(${assignmentId}, ${request.data.runId}) AS blocked
      `)
    ).rows;

    if (ownership?.blocked === true)
      throw new MaisterError(
        "CONFLICT",
        "Settle the current root execution before appointing a replacement",
        { details: { reason: "assignment_root_unsettled" } },
      );
  }
  await tx.execute(
    sql`INSERT INTO specialist_run_links(assignment_id,run_id,input_revision,role,work_id,work_revision) VALUES(${assignmentId},${request.data.runId},${request.data.inputRevision},${request.data.role},${request.data.work?.id ?? null},${request.data.work?.revision ?? null})`,
  );
  await tx.execute(
    sql`UPDATE specialist_assignments SET revision=revision+1,updated_at=clock_timestamp() WHERE id=${assignmentId}`,
  );
  const status = specialistAssignmentSchema.shape.status.parse(head.status);

  await emitSpecialistAssignmentChange({
    db: tx,
    owner,
    assignmentId,
    revision: request.data.expectedRevision + 1,
    previousStatus: status,
    status,
    cause: "work",
    actor: { type: "user", id: userId },
  });
  log.info(
    {
      assignmentId,
      runId: request.data.runId,
      role: request.data.role,
      inputRevision: request.data.inputRevision,
      revision: request.data.expectedRevision + 1,
    },
    "existing execution linked to assignment",
  );

  return {
    assignment: await getSpecialistAssignmentInTransaction(
      tx,
      userId,
      assignmentId,
    ),
    duplicate: false,
  };
}

/** Link the initial reserved execution and activate its queued assignment atomically. */
export async function activateInitialSpecialistAssignmentRunInTransaction(
  tx: SqlTransaction,
  userId: string,
  assignmentId: string,
  input: Readonly<
    Pick<
      SpecialistRunLinkInput,
      "runId" | "inputRevision" | "expectedRevision"
    > & {
      role: "coordinator" | "specialist";
    }
  >,
): Promise<number> {
  const linked = await linkSpecialistAssignmentRunInTransaction(
    tx,
    userId,
    assignmentId,
    { ...input, work: null },
  );

  if (linked.duplicate || linked.assignment.status !== "queued")
    throw new MaisterError(
      "CONFLICT",
      "Initial execution activation requires a new link on a queued assignment",
    );
  if (linked.assignment.revision >= 2147483647)
    throw new MaisterError(
      "CONFLICT",
      "Assignment revision is exhausted; preserve its history and submit new work",
    );
  const assignmentRevision = linked.assignment.revision + 1;
  const updated = await tx.execute(sql`
    UPDATE specialist_assignments SET status='active',revision=revision+1,updated_at=clock_timestamp()
    WHERE id=${assignmentId} AND revision=${linked.assignment.revision} AND status='queued'
    RETURNING id
  `);

  if (updated.rows.length !== 1)
    throw new MaisterError(
      "CONFLICT",
      "Assignment changed before initial execution activation",
    );
  await emitSpecialistAssignmentChange({
    db: tx,
    owner: linked.assignment.owner,
    assignmentId,
    revision: assignmentRevision,
    previousStatus: "queued",
    status: "active",
    cause: "state",
    actor: { type: "user", id: userId },
  });
  log.debug(
    {
      assignmentId,
      runId: input.runId,
      revision: assignmentRevision,
      status: "active",
    },
    "initial assignment execution activated",
  );

  return assignmentRevision;
}

export async function linkSpecialistAssignmentRun(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  input: SpecialistRunLinkInput,
): Promise<{ assignment: SpecialistAssignment; duplicate: boolean }> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);

      return linkSpecialistAssignmentRunInTransaction(
        tx,
        userId,
        assignmentId,
        input,
      );
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
