import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { SpecialistIntakePrincipal } from "@/lib/agents/installation-appointment";
import type { AssignmentOrigin } from "./types";
import type {
  PrepareSpecialistIntake,
  SpecialistIntakeReceipt,
  SpecialistIntakeRequest,
} from "./intake-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { assignmentOriginSchema } from "./types";
import { specialistIntakeRequestSchema } from "./intake-types";
import { authorizeAssignment } from "./access";
import {
  beginAssignmentTransaction,
  createSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "./store";

import { contentDigest } from "@/lib/evaluations/digest";
import { assertInstallationAppointment } from "@/lib/agents/installation-appointment";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "specialist-intake",
  level: process.env.LOG_LEVEL ?? "info",
});

type SpecialistIntakeIdentity = Readonly<{
  source: AssignmentOrigin;
  sourceKey: string;
  requestDigest: string;
}>;

function intakeIdentity(
  principal: SpecialistIntakePrincipal,
  origin: AssignmentOrigin,
  request: SpecialistIntakeRequest,
): SpecialistIntakeIdentity {
  const source = assignmentOriginSchema.safeParse(origin);
  const parsed = specialistIntakeRequestSchema.safeParse(request);

  if (!source.success || !parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Specialist intake requires a validated original request and canonical source identity",
    );
  const sourceKey = contentDigest({
    schemaVersion: 1,
    owner: parsed.data.owner,
    origin: source.data,
    ...(source.data.kind === "manual" ? { userId: principal } : {}),
    ...(source.data.kind === "task_comment"
      ? { specialistBindingId: parsed.data.specialistBindingId }
      : {}),
  });
  const requestDigest = contentDigest(parsed.data);

  return { source: source.data, sourceKey, requestDigest };
}

async function loadIntakeReplay(
  tx: SqlTransaction,
  principal: SpecialistIntakePrincipal,
  identity: SpecialistIntakeIdentity,
): Promise<SpecialistIntakeReceipt | null> {
  const previous = (
    await tx.execute(
      sql`SELECT id,assignment_id,input_revision,request_digest,disposition FROM specialist_intake_receipts WHERE source_kind=${identity.source.kind} AND source_key=${identity.sourceKey} FOR SHARE`,
    )
  ).rows[0];

  if (previous) {
    if (
      typeof previous.id !== "string" ||
      typeof previous.assignment_id !== "string" ||
      typeof previous.input_revision !== "number" ||
      typeof previous.request_digest !== "string" ||
      previous.disposition !== "created"
    )
      throw new MaisterError(
        "CRASH",
        "The specialist intake receipt is malformed",
      );
    const assignment = await getSpecialistAssignmentInTransaction(
      tx,
      principal,
      previous.assignment_id,
    );
    const input = await getSpecialistAssignmentInputInTransaction(
      tx,
      principal,
      previous.assignment_id,
      previous.input_revision,
    );

    if (typeof principal === "string")
      await authorizeAssignment(
        tx,
        principal,
        assignment.owner,
        "assignments:submit",
        input.snapshot.authoritySnapshot.executionPolicy,
      );
    if (previous.request_digest !== identity.requestDigest)
      throw new MaisterError(
        "CONFLICT",
        "This delivery identity already belongs to different specialist work",
        { details: { reason: "specialist_intake_payload_conflict" } },
      );
    log.info(
      {
        sourceKind: identity.source.kind,
        sourceKey: identity.sourceKey,
        receiptId: previous.id,
        assignmentId: assignment.id,
        inputRevision: previous.input_revision,
        disposition: "duplicate",
      },
      "specialist intake reused retained work",
    );

    return {
      receiptId: previous.id,
      assignment,
      inputRevision: previous.input_revision,
      duplicate: true,
      disposition: "created",
    };
  }

  return null;
}

/** Inspect an existing currently authorized delivery without provider or host activation. */
export async function inspectSpecialistIntakeReplayInTransaction(
  tx: SqlTransaction,
  principal: SpecialistIntakePrincipal,
  origin: AssignmentOrigin,
  request: SpecialistIntakeRequest,
): Promise<SpecialistIntakeReceipt | null> {
  if (typeof principal !== "string")
    assertInstallationAppointment(tx, principal, {
      companyId:
        request.owner.kind === "company" ? request.owner.companyId : null,
      bindingId: request.specialistBindingId,
      origin,
    });
  const identity = intakeIdentity(principal, origin, request);

  await beginAssignmentTransaction(tx);

  return loadIntakeReplay(tx, principal, identity);
}

/** Source adapters own identity validation; this transaction owns canonical assignment deduplication. */
export async function intakeSpecialistAssignmentInTransaction(
  tx: SqlTransaction,
  principal: SpecialistIntakePrincipal,
  origin: AssignmentOrigin,
  request: SpecialistIntakeRequest,
  prepare: PrepareSpecialistIntake,
): Promise<SpecialistIntakeReceipt> {
  if (typeof principal !== "string")
    assertInstallationAppointment(tx, principal, {
      companyId:
        request.owner.kind === "company" ? request.owner.companyId : null,
      bindingId: request.specialistBindingId,
      origin,
    });
  const identity = intakeIdentity(principal, origin, request);
  const { source, sourceKey, requestDigest } = identity;

  await beginAssignmentTransaction(tx);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"specialist-intake:" + sourceKey},0))`,
  );
  const previous = await loadIntakeReplay(tx, principal, identity);

  if (previous) return previous;
  const prepared = await prepare(tx);
  const { expectedResult: _expectedResult, ...objective } =
    prepared.objectiveInput;
  const preparedRequest = {
    ...objective,
    owner: prepared.owner,
    specialistBindingId: prepared.specialistBindingId,
  };

  if (
    contentDigest(preparedRequest) !== requestDigest ||
    contentDigest(prepared.origin) !== contentDigest(source)
  )
    throw new MaisterError(
      "CONFIG",
      "Server-prepared specialist work does not match its original request and source identity",
    );
  const assignment = await createSpecialistAssignmentInTransaction(
    tx,
    principal,
    prepared,
  );
  const input = await getSpecialistAssignmentInputInTransaction(
    tx,
    principal,
    assignment.id,
    assignment.inputRevision,
  );
  const row = (
    await tx.execute(
      sql`INSERT INTO specialist_intake_receipts(source_kind,source_key,request_digest,assignment_id,input_revision,actor) VALUES(${source.kind},${sourceKey},${requestDigest},${assignment.id},${input.revision},${JSON.stringify(input.actor)}::jsonb) RETURNING id`,
    )
  ).rows[0];

  if (!row || typeof row.id !== "string")
    throw new MaisterError(
      "CRASH",
      "Specialist intake did not retain its delivery receipt",
    );
  log.info(
    {
      sourceKind: source.kind,
      sourceKey,
      receiptId: row.id,
      assignmentId: assignment.id,
      inputRevision: input.revision,
      disposition: "created",
    },
    "specialist intake retained new work",
  );

  return {
    receiptId: row.id,
    assignment,
    inputRevision: input.revision,
    duplicate: false,
    disposition: "created",
  };
}
