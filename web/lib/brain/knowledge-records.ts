import "server-only";

import type {
  KnowledgeDatabase,
  KnowledgeTransaction,
} from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeAccessWalk } from "./knowledge-restrictions";
import type {
  KnowledgeRecordDto,
  KnowledgeRecordEvidence,
  KnowledgeRecordEvidenceSummary,
} from "./knowledge-read-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { knowledgeOwner, resolveKnowledgePrincipal } from "./knowledge-access";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "./knowledge-disclosure";
import {
  authorizeKnowledgeRecordRead,
  authorizeKnowledgeRevisionRead,
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
  unavailableKnowledgeReference,
} from "./knowledge-restrictions";
import {
  knowledgeRecordSchema,
  knowledgeRecordEvidenceSchema,
  knowledgeWitnessSummarySchema,
} from "./knowledge-read-types";
import { knowledgeRevisionSchema } from "./knowledge-types";
import {
  inspectKnowledgeWitness,
  knowledgeTimestamp,
} from "./knowledge-witnesses";
import { knowledgeRevisionReadPolicyCte } from "./knowledge-query-policy";
import { knowledgeConflictEdges } from "./knowledge-conflict-query";

import { redactQueryError } from "@/lib/db/pg-error";
import { truncateUtf16 } from "@/lib/utf8";
import { isMaisterError, MaisterError } from "@/lib/errors";

const log = pino({
  name: "brain:knowledge-read",
  level: process.env.LOG_LEVEL ?? "info",
});

export type KnowledgeRecordSelector = Readonly<{
  recordId: string;
  revision?: number;
}>;
export type KnowledgeRecordRead = Readonly<{
  record: KnowledgeRecordDto;
  access: KnowledgeAccessWalk;
  evidence: readonly KnowledgeRecordEvidence[];
}>;

export async function getKnowledgeRecord(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  selector: KnowledgeRecordSelector,
): Promise<KnowledgeRecordDto> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const consumer = await lockKnowledgeReadConsumer(tx, principal);

      await resolveKnowledgePrincipal(tx, principal, "knowledge:read");
      const result = await readKnowledgeRecord(tx, principal, selector);

      if (Buffer.byteLength(JSON.stringify(result.record), "utf8") > 524288)
        throw new MaisterError(
          "PRECONDITION",
          "Knowledge record exceeds the bounded detail response limit",
        );
      await recordKnowledgeDisclosure(
        tx,
        consumer,
        restrictionsForKnowledgeAccess(result.access),
      );
      log.debug(
        {
          recordId: selector.recordId,
          revision: result.record.revision,
          evidenceCount: result.record.evidence.length,
          diagnosticCodes: result.record.diagnostics,
        },
        "structured knowledge disclosed",
      );

      return result.record;
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Exact accepted bytes and all source checks remain in the caller's transaction. */
export async function readKnowledgeRecord(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  selector: KnowledgeRecordSelector,
  initial: KnowledgeAccessWalk = { visited: [], remaining: 256 },
): Promise<KnowledgeRecordRead> {
  if (
    selector.revision !== undefined &&
    !knowledgeRevisionSchema.safeParse(selector.revision).success
  )
    throw new MaisterError(
      "CONFIG",
      "An exact bounded record revision is required",
    );
  const metadata = await authorizeKnowledgeRecordRead(
    tx,
    principal,
    selector.recordId,
    initial,
  );
  const revision = selector.revision ?? metadata.record.current_revision;
  const row = (
    await tx.execute(sql`
    SELECT i.id,i.project_id,i.company_id,i.status,i.visibility,i.updated_at,
      r.revision,r.title,r.assertion,r.kind,r.basis,r.attribution,r.freshness,r.limitations,r.missing_evidence,r.source_restrictions,r.provenance
    FROM brain_items i JOIN brain_record_revisions r ON r.record_id=i.id AND r.revision=${revision} WHERE i.id=${selector.recordId}
  `)
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();
  let access = await authorizeSourceRestrictions(
    tx,
    principal,
    row.source_restrictions,
    metadata.access,
  );
  const proof = await readRecordEvidence(
    tx,
    principal,
    selector.recordId,
    revision,
    access,
  );

  access = proof.access;
  const confirmation = await readRecordConfirmation(
    tx,
    selector.recordId,
    revision,
    proof.items,
  );
  const conflict = await readRecordConflict(
    tx,
    principal,
    selector.recordId,
    revision,
    access,
  );
  const retained = retainedLimitations(row.limitations, row.provenance);

  if (typeof row.assertion !== "string")
    throw new MaisterError("CONFIG", "Retained assertion content is invalid");
  const assertion = truncateUtf16(row.assertion, 32000);
  const assertionTruncated = assertion.length !== row.assertion.length;

  const diagnostics: KnowledgeRecordDto["diagnostics"] = [
    ...retained.diagnostics,
    ...(row.source_restrictions === null
      ? (["historical_source_classification_unknown"] as const)
      : []),
    ...(assertionTruncated ? (["assertion_truncated"] as const) : []),
    ...(proof.items.some((entry) => "unavailable" in entry)
      ? (["accepted_evidence_unavailable"] as const)
      : []),
  ];

  const fresh = row.freshness as KnowledgeRecordDto["freshness"];
  const parsed = knowledgeRecordSchema.safeParse({
    id: row.id,
    owner: knowledgeOwner(row),
    revision,
    title: row.title,
    assertion,
    assertionTruncated,
    kind: row.kind,
    basis: row.basis,
    lifecycle: row.status,
    visibility: row.visibility,
    evidence: proof.items.map(evidenceSummary),
    missingEvidence: row.missing_evidence,
    confirmation,
    attribution: row.attribution,
    freshness: {
      ...fresh,
      observedAt: knowledgeTimestamp(fresh.observedAt),
      sourceAt: knowledgeTimestamp(fresh.sourceAt),
      capturedAt: knowledgeTimestamp(fresh.capturedAt),
    },
    limitations: retained.limitations,
    diagnostics,
    conflict: conflict.value,
    updatedAt: knowledgeTimestamp(row.updated_at),
  });

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Stored knowledge record does not match its native read contract",
    );

  return {
    record: parsed.data,
    access: conflict.access,
    evidence: proof.items,
  };
}

export function evidenceSummary(
  item: KnowledgeRecordEvidence,
): KnowledgeRecordEvidenceSummary {
  if ("unavailable" in item) return item;
  const {
    excerpt: _excerpt,
    excerptTruncated: _truncated,
    ...witness
  } = item.witness;

  return {
    relation: item.relation,
    witness: knowledgeWitnessSummarySchema.parse(witness),
  };
}

async function readRecordEvidence(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  recordId: string,
  revision: number,
  initial: KnowledgeAccessWalk,
): Promise<{ items: KnowledgeRecordEvidence[]; access: KnowledgeAccessWalk }> {
  const links = (
    await tx.execute(
      sql`SELECT e.witness_id,e.relation,e.witness_snapshot,w.id AS available_id FROM brain_revision_evidence e LEFT JOIN brain_evidence_witnesses w ON w.id=e.witness_id WHERE e.record_id=${recordId} AND e.revision=${revision} ORDER BY e.witness_id,e.relation LIMIT 65`,
    )
  ).rows;

  if (links.length > 64)
    throw new MaisterError(
      "PRECONDITION",
      "Knowledge evidence exceeds its bounded record contract",
    );
  const items: KnowledgeRecordEvidence[] = [];
  let access = initial;

  for (const link of links) {
    const snapshot = link.witness_snapshot as Readonly<{
      restrictions?: unknown;
      sha256?: unknown;
      sourceVersion?: unknown;
    }>;

    access = await authorizeSourceRestrictions(
      tx,
      principal,
      snapshot.restrictions ?? null,
      access,
    );
    if (link.available_id === null) {
      items.push(
        knowledgeRecordEvidenceSchema.parse({
          relation: link.relation,
          unavailable: {
            state: "missing",
            reasonCode: "record_evidence_missing",
            reason:
              "Retained evidence is unavailable; no source metadata has been reconstructed.",
          },
        }),
      );
      continue;
    }
    const inspection = await inspectKnowledgeWitness(
      tx,
      principal,
      String(link.witness_id),
      access,
    );

    if (
      (snapshot.sha256 !== undefined &&
        snapshot.sha256 !== inspection.witness.sha256) ||
      (snapshot.sourceVersion !== undefined &&
        snapshot.sourceVersion !== inspection.witness.sourceVersion)
    )
      throw new MaisterError(
        "CONFIG",
        "Accepted evidence does not match its immutable version witness",
      );
    access = inspection.access;
    items.push(
      knowledgeRecordEvidenceSchema.parse({
        relation: link.relation,
        witness: inspection.witness,
      }),
    );
  }

  return { items, access };
}

async function readRecordConfirmation(
  tx: KnowledgeTransaction,
  recordId: string,
  revision: number,
  evidence: readonly KnowledgeRecordEvidence[],
): Promise<KnowledgeRecordDto["confirmation"]> {
  const row = (
    await tx.execute(
      sql`SELECT id,decision,confirmer,policy_snapshot,evidence_witnesses FROM brain_confirmations WHERE record_id=${recordId} AND record_revision=${revision} ORDER BY decision_sequence DESC LIMIT 1`,
    )
  ).rows[0];

  if (!row)
    return {
      state: "unconfirmed",
      decisionId: null,
      policyVersion: null,
      confirmer: null,
      witnessIds: [],
    };
  const accessibleIds = new Set(
    evidence.flatMap((item) => ("witness" in item ? [item.witness.id] : [])),
  );
  const witnesses = row.evidence_witnesses as Readonly<{ id: string }>[];

  return {
    state: row.decision === "confirm" ? "confirmed" : "revoked",
    decisionId: String(row.id),
    policyVersion: Number((row.policy_snapshot as { version: number }).version),
    confirmer: row.confirmer as KnowledgeRecordDto["confirmation"]["confirmer"],
    witnessIds: [
      ...new Set(
        witnesses
          .map((entry) => entry.id)
          .filter((id) => accessibleIds.has(id)),
      ),
    ],
  };
}

function retainedLimitations(
  raw: unknown,
  provenance: unknown,
): Pick<KnowledgeRecordDto, "limitations" | "diagnostics"> {
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string"))
    throw new MaisterError(
      "CONFIG",
      "Stored knowledge limitations are invalid",
    );
  if (
    provenance !== "submitted" &&
    provenance !== "legacy_migration" &&
    provenance !== "legacy_writer"
  )
    throw new MaisterError("CONFIG", "Stored knowledge provenance is invalid");
  const legacy =
    provenance === "legacy_migration"
      ? {
          text: "Legacy metadata does not establish submitting identity, observation time or confirmation.",
          code: "legacy_metadata_unknown" as const,
        }
      : provenance === "legacy_writer"
        ? {
            text: "Legacy writer metadata does not establish submitting identity, observation time or confirmation.",
            code: "legacy_writer_metadata_unknown" as const,
          }
        : null;

  return {
    limitations: raw.filter((entry) => entry !== legacy?.text),
    diagnostics: legacy && raw.includes(legacy.text) ? [legacy.code] : [],
  };
}

async function readRecordConflict(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  recordId: string,
  revision: number,
  initial: KnowledgeAccessWalk,
): Promise<{
  value: KnowledgeRecordDto["conflict"];
  access: KnowledgeAccessWalk;
}> {
  const edges = knowledgeConflictEdges(recordId, revision);
  const identity = await resolveKnowledgePrincipal(
    tx,
    principal,
    "knowledge:read",
  );
  const policy = knowledgeRevisionReadPolicyCte(
    identity,
    sql`SELECT e.record_id,e.revision FROM (${edges}) e`,
  );
  const visible = (
    await tx.execute(
      sql`${policy} SELECT id,array_agg(selected_revision ORDER BY selected_revision) AS revisions FROM knowledge_readable_records GROUP BY id ORDER BY id LIMIT 65`,
    )
  ).rows;
  const linked = (
    await tx.execute(
      sql`SELECT count(DISTINCT CASE WHEN from_ref->>'id'=${recordId} THEN to_ref->>'id' ELSE from_ref->>'id' END)::integer AS count FROM brain_edges WHERE claim_state IS NOT NULL AND ((from_ref->>'id'=${recordId} AND from_revision=${revision}) OR (to_ref->>'id'=${recordId} AND to_revision=${revision}))`,
    )
  ).rows[0];
  const accessibleRecordIds: string[] = [];
  let access = initial;
  let incomplete = visible.length > 64 || visible.length < Number(linked.count);

  for (const other of visible.slice(0, 64)) {
    try {
      for (const selectedRevision of other.revisions as number[])
        access = await authorizeKnowledgeRevisionRead(
          tx,
          principal,
          String(other.id),
          selectedRevision,
          access,
        );
      accessibleRecordIds.push(String(other.id));
    } catch (error) {
      if (!isMaisterError(error) || error.code !== "PRECONDITION") throw error;
      incomplete = true;
      if (error.details?.reason === "knowledge_reference_budget_exceeded")
        break;
    }
  }

  return {
    value: {
      state: incomplete
        ? "limited"
        : accessibleRecordIds.length === 0
          ? "none_known"
          : "unresolved",
      accessibleRecordIds,
      incomplete,
    },
    access,
  };
}
