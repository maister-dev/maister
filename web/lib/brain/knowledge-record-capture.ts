import "server-only";

import type { KnowledgeAttribution } from "./record-types";
import type { KnowledgeTransaction } from "./knowledge-access";
import type { KnowledgePrincipal, KnowledgeReference } from "./knowledge-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { knowledgeOwner } from "./knowledge-access";
import { sha256 } from "./codec";
import {
  authorizeKnowledgeRevisionRead,
  restrictionsForKnowledgeAccess,
  unavailableKnowledgeReference,
} from "./knowledge-restrictions";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "brain:record-capture",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Pin assertion bytes without promoting a quoted claim into independent observation. */
export async function captureKnowledgeRecordReference(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  reference: KnowledgeReference,
  actor: KnowledgeAttribution,
): Promise<string> {
  if (reference.kind !== "knowledge" || reference.revision === undefined)
    throw new MaisterError(
      "CONFIG",
      "Knowledge evidence requires an exact record revision",
    );
  const access = await authorizeKnowledgeRevisionRead(
    tx,
    principal,
    reference.id,
    reference.revision,
  );
  const row = (
    await tx.execute(sql`
    SELECT i.project_id,i.company_id,r.assertion,r.content_sha256
    FROM brain_record_revisions r JOIN brain_items i ON i.id=r.record_id
    WHERE r.record_id=${reference.id} AND r.revision=${reference.revision}
  `)
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();
  const content = String(row.assertion);

  if (sha256(content) !== row.content_sha256)
    throw new MaisterError(
      "CRASH",
      "Retained knowledge assertion does not match its revision digest",
    );
  const version = String(reference.revision);

  if (
    (reference.version !== undefined && reference.version !== version) ||
    (reference.sha256 !== undefined && reference.sha256 !== row.content_sha256)
  )
    throw new MaisterError(
      "CONFLICT",
      "Knowledge evidence version does not match its retained revision",
    );
  const owner = knowledgeOwner(row);
  const sourceId = `record:${sha256(reference.id)}`;
  const selector = `record:${reference.id}:${version}`;
  const projectId = owner.kind === "project" ? owner.projectId : null;
  const companyId = owner.kind === "company" ? owner.companyId : null;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-record-capture:${reference.id}:${version}`},0))`,
  );
  const existing = (
    await tx.execute(sql`
    SELECT w.id FROM brain_evidence_witnesses w JOIN brain_evidence_observations o ON o.id=w.observation_id
    WHERE o.project_id IS NOT DISTINCT FROM ${projectId} AND o.company_id IS NOT DISTINCT FROM ${companyId}
      AND o.source_id=${sourceId} AND o.source_version=${version} AND o.content_sha256=${row.content_sha256} AND w.selector=${selector}
  `)
  ).rows[0];

  if (typeof existing?.id === "string") return existing.id;
  const restrictions = restrictionsForKnowledgeAccess(access);
  const locator = {
    kind: "record",
    recordId: reference.id,
    revision: reference.revision,
    content,
  };

  if (Buffer.byteLength(JSON.stringify(locator), "utf8") > 262144)
    throw new MaisterError(
      "CONFIG",
      "Record evidence exceeds the bounded capture limit",
    );
  const observation = (
    await tx.execute(sql`
    INSERT INTO brain_evidence_observations(project_id,company_id,source_id,source_version,content_sha256,attribution)
    VALUES(${projectId},${companyId},${sourceId},${version},${row.content_sha256},${JSON.stringify(actor)}::jsonb) RETURNING id
  `)
  ).rows[0];

  if (typeof observation?.id !== "string")
    throw new MaisterError(
      "CRASH",
      "Record evidence observation was not retained",
    );
  const witness = (
    await tx.execute(sql`
    INSERT INTO brain_evidence_witnesses(observation_id,source_version,content_sha256,selector,restrictions,capture_locator)
    VALUES(${observation.id},${version},${row.content_sha256},${selector},${JSON.stringify(restrictions)}::jsonb,${JSON.stringify(locator)}::jsonb) RETURNING id
  `)
  ).rows[0];

  if (typeof witness?.id !== "string")
    throw new MaisterError("CRASH", "Record evidence witness was not retained");
  log.debug(
    {
      recordId: reference.id,
      revision: reference.revision,
      witnessId: witness.id,
    },
    "record evidence captured",
  );

  return witness.id;
}
