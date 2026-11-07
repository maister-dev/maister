import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type {
  AssignmentContext,
  AssignmentContextSnapshot,
  AssignmentContextEntry,
} from "./context-types";
import type { AssignmentInputRevision } from "./types";
import type { KnowledgeAccessWalk } from "@/lib/brain/knowledge-restrictions";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  assignmentContextSchema,
  assignmentContextSnapshotSchema,
  assignmentContextUpdateSchema,
} from "./context-types";
import { authorizeAssignment } from "./access";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "./store";

import {
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
} from "@/lib/brain/knowledge-restrictions";
import { inspectKnowledgeEvidenceReference } from "@/lib/brain/knowledge-reference";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { redactQueryError, queryErrorDiagnostics } from "@/lib/db/pg-error";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { emitSpecialistAssignmentChange } from "@/lib/domain-events/outbox";

const log = pino({
  name: "specialist-context",
  level: process.env.LOG_LEVEL ?? "info",
});
const retainedRevision = z.number().int().min(0).max(2147483647);
const MAX_CONTEXT_BYTES = 131072;
const MAX_UPDATE_BYTES = 32768;

type ContextRead = Readonly<{
  value: AssignmentContext;
  input: AssignmentInputRevision;
  access: KnowledgeAccessWalk;
}>;

function contextConflict(message: string): MaisterError {
  return new MaisterError("CONFLICT", message, {
    details: { reason: "assignment_context_conflict" },
  });
}

/** A historical revision is disclosed only under current assignment and complete inherited-source access. */
async function readContextInTransaction(
  tx: SqlTransaction,
  userId: string,
  assignmentId: string,
  revision: number,
): Promise<ContextRead> {
  const assignment = await getSpecialistAssignmentInTransaction(
    tx,
    userId,
    assignmentId,
  );

  if (
    !retainedRevision.safeParse(revision).success ||
    revision > assignment.contextRevision
  )
    throw new MaisterError(
      "PRECONDITION",
      "The requested context revision is unavailable",
      { details: { reason: "assignment_context_unavailable" } },
    );
  const row =
    revision === 0
      ? null
      : (
          await tx.execute(
            sql`SELECT * FROM specialist_context_revisions WHERE assignment_id=${assignmentId} AND revision=${revision} FOR SHARE`,
          )
        ).rows[0];

  if (row === undefined)
    throw new MaisterError(
      "CONFIG",
      "The retained context head has no matching history; inspect migration and transaction integrity",
    );
  const input = await getSpecialistAssignmentInputInTransaction(
    tx,
    userId,
    assignmentId,
    row === null ? assignment.inputRevision : Number(row.input_revision),
  );
  let access = await authorizeSourceRestrictions(tx, { kind: "user", userId }, [
    ...input.snapshot.sourceRestrictions,
    {
      kind: "assignment_input",
      assignmentId,
      inputRevision: input.revision,
      inputSha256: input.digest,
    },
  ]);
  let snapshot: AssignmentContextSnapshot = {
    schemaVersion: 1,
    inputRevision: input.revision,
    inputSha256: input.digest,
    entries: [],
  };

  if (row !== null) {
    access = await authorizeSourceRestrictions(
      tx,
      { kind: "user", userId },
      row.source_restrictions,
      access,
    );
    const parsed = assignmentContextSnapshotSchema.safeParse(row.context);

    if (
      !parsed.success ||
      parsed.data.inputRevision !== input.revision ||
      parsed.data.inputSha256 !== input.digest ||
      contentDigest(parsed.data) !== row.content_digest
    )
      throw new MaisterError(
        "CONFIG",
        "Retained working context does not match its exact input and content witness",
      );
    snapshot = parsed.data;
  }
  const parsed = assignmentContextSchema.safeParse({
    schemaVersion: 1,
    assignmentId,
    revision,
    baseRevision: row === null ? 0 : row.base_revision,
    recording: row === null ? "unrecorded" : "recorded",
    inputRevision: input.revision,
    inputSha256: input.digest,
    currentInputRevision: assignment.inputRevision,
    objective: input.snapshot.objectiveInput.objective,
    expectedOutcome: input.snapshot.objectiveInput.expectedOutcome,
    constraints: input.snapshot.objectiveInput.constraints,
    entries: snapshot.entries,
    digest: row === null ? null : row.content_digest,
    createdAt: row === null ? null : databaseTimestamp(row.created_at),
  });

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Stored working context cannot be projected through its versioned contract",
    );

  return { value: parsed.data, input, access };
}

export async function getSpecialistAssignmentContext(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  revision?: number,
): Promise<AssignmentContext> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const assignment = await getSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
      );

      return (
        await readContextInTransaction(
          tx,
          userId,
          assignmentId,
          revision ?? assignment.contextRevision,
        )
      ).value;
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Notes may express missing evidence; an asserted reference must resolve without inventing a witness. */
async function inspectEntrySources(
  tx: SqlTransaction,
  userId: string,
  entry: AssignmentContextEntry,
  initial: KnowledgeAccessWalk,
): Promise<KnowledgeAccessWalk> {
  let access = initial;
  const references = [...entry.references];

  if (entry.kind === "finding") {
    if (
      entry.findings.findings.some(
        (finding) => finding.sourceFindings.length > 0,
      ) ||
      entry.findings.selection.length > 0
    )
      throw new MaisterError(
        "PRECONDITION",
        "Context result lineage requires its governed exact-result appointment",
        { details: { reason: "context_result_reference_unavailable" } },
      );
    references.push(
      ...entry.findings.findings.flatMap((finding) => [
        ...finding.supporting,
        ...finding.contradicting,
      ]),
      ...entry.findings.knowledgeProposals.flatMap((proposal) =>
        proposal.evidence.map((item) => item.reference),
      ),
    );
  }
  for (const reference of references)
    access = await inspectKnowledgeEvidenceReference(
      tx,
      { kind: "user", userId },
      reference,
      access,
    );

  return access;
}

/** Human working edits retain no fabricated execution epoch; agent appointment/fencing is integrated separately. */
export async function appendSpecialistAssignmentContext(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  value: unknown,
): Promise<AssignmentContext> {
  const parsed = assignmentContextUpdateSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Context updates require the exact input/context revisions, distinct bounded entries and a delivery key",
    );
  const update = parsed.data;

  if (Buffer.byteLength(JSON.stringify(update), "utf8") > MAX_UPDATE_BYTES)
    throw new MaisterError("CONFIG", "Context update exceeds 32 KiB", {
      details: { reason: "assignment_context_update_too_large" },
    });
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      await tx.execute(
        sql`SELECT id FROM specialist_assignments WHERE id=${assignmentId} FOR UPDATE`,
      );
      const assignment = await getSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
      );
      const currentInput = await getSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        assignmentId,
        assignment.inputRevision,
      );
      const authority = await authorizeAssignment(
        tx,
        userId,
        assignment.owner,
        "assignments:update",
        currentInput.snapshot.authoritySnapshot.executionPolicy,
      );
      const principalKey = contentDigest(authority.actor);
      const requestDigest = contentDigest(update);
      const previous = (
        await tx.execute(
          sql`SELECT revision,request_digest FROM specialist_context_revisions WHERE assignment_id=${assignmentId} AND principal_key=${principalKey} AND request_key=${update.idempotencyKey} FOR SHARE`,
        )
      ).rows[0];

      if (previous) {
        if (previous.request_digest !== requestDigest)
          throw contextConflict(
            "A context delivery key cannot identify different content",
          );

        log.debug(
          { assignmentId, contextRevision: previous.revision },
          "working context replay adopted its retained revision",
        );

        return (
          await readContextInTransaction(
            tx,
            userId,
            assignmentId,
            Number(previous.revision),
          )
        ).value;
      }
      if (["completed", "failed", "cancelled"].includes(assignment.status))
        throw new MaisterError(
          "PRECONDITION",
          "Terminal assignments cannot receive new working context",
        );
      if (
        assignment.contextRevision !== update.expectedRevision ||
        assignment.inputRevision !== update.expectedInputRevision ||
        assignment.contextRevision === 2147483647 ||
        assignment.revision === 2147483647
      )
        throw contextConflict(
          "Assignment input or context changed; inspect the current revisions before rebasing this edit",
        );
      const current = await readContextInTransaction(
        tx,
        userId,
        assignmentId,
        assignment.contextRevision,
      );
      const ids = new Set(current.value.entries.map((item) => item.entry.id));
      const replacements = new Set(
        update.updates.flatMap((entry) =>
          entry.supersedesEntryId === undefined
            ? []
            : [entry.supersedesEntryId],
        ),
      );

      for (const entry of update.updates) {
        if (
          ids.has(entry.id) ||
          (entry.supersedesEntryId !== undefined &&
            !ids.has(entry.supersedesEntryId))
        )
          throw contextConflict(
            "New context entries require distinct identities and an exact existing replacement target",
          );
      }
      let access = await authorizeSourceRestrictions(
        tx,
        { kind: "user", userId },
        [
          ...currentInput.snapshot.sourceRestrictions,
          {
            kind: "assignment_input",
            assignmentId,
            inputRevision: currentInput.revision,
            inputSha256: currentInput.digest,
          },
        ],
        current.access,
      );

      for (const entry of update.updates)
        access = await inspectEntrySources(tx, userId, entry, access);
      const nextRevision = assignment.contextRevision + 1;
      const snapshot = assignmentContextSnapshotSchema.safeParse({
        schemaVersion: 1,
        inputRevision: currentInput.revision,
        inputSha256: currentInput.digest,
        entries: [
          ...current.value.entries.filter(
            (item) => !replacements.has(item.entry.id),
          ),
          ...update.updates.map((entry) => ({
            entry,
            actor: authority.actor,
            introducedRevision: nextRevision,
            ownerEpoch: null,
          })),
        ],
      });

      if (!snapshot.success)
        throw new MaisterError(
          "CONFIG",
          "Working context exceeds its versioned entry bounds",
        );
      const bytes = (
        await tx.execute(
          sql`SELECT octet_length(${JSON.stringify(snapshot.data)}::jsonb::text) AS bytes`,
        )
      ).rows[0]?.bytes;

      if (typeof bytes !== "number")
        throw new MaisterError(
          "CRASH",
          "Context storage did not return its bounded serialized size",
        );
      if (bytes > MAX_CONTEXT_BYTES)
        throw new MaisterError(
          "CONFIG",
          "Retained context exceeds 128 KiB; explicitly supersede entries before adding work",
          { details: { reason: "assignment_context_too_large" } },
        );
      const restrictions = restrictionsForKnowledgeAccess(access);

      await tx.execute(sql`INSERT INTO specialist_context_revisions(assignment_id,revision,base_revision,input_revision,context,source_restrictions,actor,owner_epoch,principal_key,request_key,request_digest,content_digest)
        VALUES(${assignmentId},${nextRevision},${assignment.contextRevision},${currentInput.revision},${JSON.stringify(snapshot.data)}::jsonb,${JSON.stringify(restrictions)}::jsonb,${JSON.stringify(authority.actor)}::jsonb,NULL,${principalKey},${update.idempotencyKey},${requestDigest},${contentDigest(snapshot.data)})`);
      await tx.execute(
        sql`UPDATE specialist_assignments SET context_revision=${nextRevision},revision=revision+1,updated_at=clock_timestamp() WHERE id=${assignmentId}`,
      );
      await emitSpecialistAssignmentChange({
        db: tx,
        owner: assignment.owner,
        assignmentId,
        revision: assignment.revision + 1,
        previousStatus: assignment.status,
        status: assignment.status,
        cause: "context",
        actor: { type: "user", id: userId },
      });
      log.info(
        {
          assignmentId,
          contextRevision: nextRevision,
          inputRevision: currentInput.revision,
          entryCount: snapshot.data.entries.length,
          sourceCount: restrictions.length,
          actorKind: authority.actor.kind,
        },
        "working context revision retained",
      );

      return (
        await readContextInTransaction(tx, userId, assignmentId, nextRevision)
      ).value;
    });
  } catch (error) {
    log.warn(
      {
        assignmentId,
        expectedContextRevision: update.expectedRevision,
        expectedInputRevision: update.expectedInputRevision,
        code: isMaisterError(error) ? error.code : undefined,
        reason: isMaisterError(error) ? error.details?.reason : undefined,
        ...queryErrorDiagnostics(error),
      },
      "working context update refused",
    );
    throw redactQueryError(error);
  }
}
