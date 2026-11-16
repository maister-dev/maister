import "server-only";

import type { KnowledgeAttribution } from "./record-types";
import type { KnowledgeTransaction } from "./knowledge-access";
import type { KnowledgePrincipal, KnowledgeReference } from "./knowledge-types";
import type { KnowledgeAccessWalk } from "./knowledge-restrictions";

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

type RecordCapture = Readonly<{
  projectId: string | null;
  companyId: string | null;
  sourceId: string;
  selector: string;
  version: string;
  digest: string;
  content: string;
  access: KnowledgeAccessWalk;
}>;

async function readRecordCapture(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  reference: KnowledgeReference,
  initial: KnowledgeAccessWalk,
): Promise<RecordCapture> {
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
    initial,
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

  return {
    projectId: owner.kind === "project" ? owner.projectId : null,
    companyId: owner.kind === "company" ? owner.companyId : null,
    sourceId: `record:${sha256(reference.id)}`,
    selector: `record:${reference.id}:${version}`,
    version,
    digest: String(row.content_sha256),
    content,
    access,
  };
}

async function retainedRecordWitnessId(
  tx: KnowledgeTransaction,
  capture: RecordCapture,
): Promise<string | null> {
  const { projectId, companyId, sourceId, version, digest, selector } = capture;
  const existing = (
    await tx.execute(sql`
    SELECT w.id FROM brain_evidence_witnesses w JOIN brain_evidence_observations o ON o.id=w.observation_id
    WHERE o.project_id IS NOT DISTINCT FROM ${projectId} AND o.company_id IS NOT DISTINCT FROM ${companyId}
      AND o.source_id=${sourceId} AND o.source_version=${version} AND o.content_sha256=${digest} AND w.selector=${selector}
  `)
  ).rows[0];

  return typeof existing?.id === "string" ? existing.id : null;
}

/** Resolve the already retained witness; inspection never creates evidence. */
export async function resolveKnowledgeRecordCapture(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  reference: KnowledgeReference,
  initial: KnowledgeAccessWalk,
): Promise<{ witnessId: string | null; access: KnowledgeAccessWalk }> {
  const capture = await readRecordCapture(tx, principal, reference, initial);

  return {
    witnessId: await retainedRecordWitnessId(tx, capture),
    access: capture.access,
  };
}

/** Pin assertion bytes without promoting a quoted claim into independent observation. */
export async function captureKnowledgeRecordReference(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  reference: KnowledgeReference,
  actor: KnowledgeAttribution,
): Promise<string> {
  const capture = await readRecordCapture(tx, principal, reference, {
    visited: [],
    remaining: 256,
  });
  const {
    projectId,
    companyId,
    sourceId,
    version,
    digest,
    selector,
    content,
    access,
  } = capture;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-record-capture:${reference.id}:${version}`},0))`,
  );
  const existing = await retainedRecordWitnessId(tx, capture);

  if (existing !== null) return existing;
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
    VALUES(${projectId},${companyId},${sourceId},${version},${digest},${JSON.stringify(actor)}::jsonb) RETURNING id
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
    VALUES(${observation.id},${version},${digest},${selector},${JSON.stringify(restrictions)}::jsonb,${JSON.stringify(locator)}::jsonb) RETURNING id
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
