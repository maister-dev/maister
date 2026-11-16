import "server-only";

import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type {
  KnowledgeDatabase,
  KnowledgeTransaction,
} from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";
import type {
  KnowledgeSourceCapture,
  KnowledgeWitnessDto,
} from "./knowledge-read-types";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";

import { authorizeKnowledge } from "./knowledge-access";
import {
  canonicalKnowledgeRestrictions,
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "./knowledge-disclosure";
import { knowledgeSourceCaptureSchema } from "./knowledge-read-types";
import { inspectKnowledgeWitness } from "./knowledge-witnesses";
import { sha256 } from "./codec";

import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

const log = pino({
  name: "brain:source-capture",
  level: process.env.LOG_LEVEL ?? "info",
});

type CaptureResult = Readonly<{
  witness: KnowledgeWitnessDto;
  duplicate: boolean;
}>;

export async function captureKnowledgeSource(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  input: KnowledgeSourceCapture,
): Promise<CaptureResult> {
  const parsed = knowledgeSourceCaptureSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Submitted source does not match the bounded native capture contract",
    );
  const content = parsed.data;
  const digest = contentDigest({
    owner: content.owner,
    title: content.title,
    content: content.content,
    reportedSourceVersion: content.reportedSourceVersion ?? null,
  });

  try {
    return await db.transaction(async (tx) => {
      const consumer = await lockKnowledgeReadConsumer(tx, principal);
      const authority = await authorizeKnowledge(
        tx,
        principal,
        content.owner,
        "knowledge:propose",
      );

      await authorizeKnowledge(tx, principal, content.owner, "knowledge:read");
      const ownerId =
        content.owner.kind === "company"
          ? content.owner.companyId
          : content.owner.projectId;
      const principalKey = `${authority.actor.kind}:${authority.actor.id}`;
      const restrictions = canonicalKnowledgeRestrictions([
        content.owner,
        ...(consumer?.capture.restrictions ?? []),
      ]);

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-source-delivery:${content.owner.kind}:${ownerId}:${principalKey}`},0))`,
      );
      const prior = (
        await tx.execute(
          sql`SELECT witness_id,request_digest FROM brain_source_submissions WHERE project_id IS NOT DISTINCT FROM ${content.owner.kind === "project" ? content.owner.projectId : null} AND company_id IS NOT DISTINCT FROM ${content.owner.kind === "company" ? content.owner.companyId : null} AND principal_key=${principalKey} AND delivery_key=${content.idempotencyKey}`,
        )
      ).rows[0];

      if (prior) {
        if (prior.request_digest !== digest)
          throw new MaisterError(
            "CONFLICT",
            "Source delivery key already names different bytes or metadata",
          );
        const inspection = await inspectKnowledgeWitness(
          tx,
          principal,
          String(prior.witness_id),
        );

        await recordKnowledgeDisclosure(tx, consumer, restrictions);

        return { witness: inspection.witness, duplicate: true };
      }
      const capture = await retainSourceCapture(tx, {
        content,
        restrictions,
        actor: authority.actor,
      });

      await tx.execute(
        sql`INSERT INTO brain_source_submissions(project_id,company_id,principal_key,delivery_key,request_digest,source_id,witness_id,attribution) VALUES(${content.owner.kind === "project" ? content.owner.projectId : null},${content.owner.kind === "company" ? content.owner.companyId : null},${principalKey},${content.idempotencyKey},${digest},${capture.sourceId},${capture.witnessId},${JSON.stringify(authority.actor)}::jsonb)`,
      );
      const inspection = await inspectKnowledgeWitness(
        tx,
        principal,
        capture.witnessId,
      );

      await recordKnowledgeDisclosure(tx, consumer, restrictions);
      log.info(
        {
          ownerKind: content.owner.kind,
          ownerId,
          sourceId: capture.sourceId,
          witnessId: capture.witnessId,
          bytes: Buffer.byteLength(content.content, "utf8"),
          duplicate: capture.duplicate,
        },
        "source capture retained",
      );

      return { witness: inspection.witness, duplicate: capture.duplicate };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

type RetainCapture = Readonly<{
  content: KnowledgeSourceCapture;
  restrictions: readonly KnowledgeAccessRestriction[];
  actor: Readonly<{
    kind: "user" | "agent";
    id: string;
    runId: string | null;
    attemptId: string | null;
  }>;
}>;
export async function retainSourceCapture(
  tx: KnowledgeTransaction,
  input: RetainCapture,
): Promise<{ sourceId: string; witnessId: string; duplicate: boolean }> {
  const { content, restrictions, actor } = input;
  const contentHash = sha256(content.content);
  const path = `/native-capture/${contentDigest({ title: content.title, hash: contentHash, reportedSourceVersion: content.reportedSourceVersion ?? null, restrictions })}`;
  const projectId =
    content.owner.kind === "project" ? content.owner.projectId : null;
  const companyId =
    content.owner.kind === "company" ? content.owner.companyId : null;
  const locator = {
    kind: "inline",
    content: content.content,
    reportedSourceVersion: content.reportedSourceVersion ?? null,
  };

  if (Buffer.byteLength(JSON.stringify(locator), "utf8") > 262144)
    throw new MaisterError(
      "CONFIG",
      "Submitted source exceeds the immutable capture byte limit",
    );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-source:${projectId ?? companyId}:${path}`},0))`,
  );
  const existing = (
    await tx.execute(
      sql`SELECT w.id,o.source_id FROM brain_evidence_witnesses w JOIN brain_evidence_observations o ON o.id=w.observation_id JOIN brain_sources s ON s.id=o.source_id WHERE s.project_id IS NOT DISTINCT FROM ${projectId} AND s.company_id IS NOT DISTINCT FROM ${companyId} AND s.path=${path} AND w.selector='submitted:text'`,
    )
  ).rows[0];

  if (existing)
    return {
      sourceId: String(existing.source_id),
      witnessId: String(existing.id),
      duplicate: true,
    };
  const sourceId = randomUUID();
  const observationId = randomUUID();
  const witnessId = randomUUID();
  const extras = restrictions.filter(
    (restriction) =>
      contentDigest(restriction) !== contentDigest(content.owner),
  );

  await tx.execute(
    sql`INSERT INTO brain_sources(id,project_id,company_id,kind,path,title,submitted_content,source_hash,chunker_id,chunker_version,enabled,source_restrictions) VALUES(${sourceId},${projectId},${companyId},'text',${path},${content.title},${content.content},${contentHash},'native_submission','1',false,${JSON.stringify(extras)}::jsonb)`,
  );
  await tx.execute(
    sql`INSERT INTO brain_evidence_observations(id,project_id,company_id,source_id,source_version,content_sha256,attribution) VALUES(${observationId},${projectId},${companyId},${sourceId},${`sha256:${contentHash}`},${contentHash},${JSON.stringify(actor)}::jsonb)`,
  );
  await tx.execute(
    sql`INSERT INTO brain_evidence_witnesses(id,observation_id,source_version,content_sha256,selector,restrictions,capture_locator) VALUES(${witnessId},${observationId},${`sha256:${contentHash}`},${contentHash},'submitted:text',${JSON.stringify(restrictions)}::jsonb,${JSON.stringify(locator)}::jsonb)`,
  );

  return { sourceId, witnessId, duplicate: false };
}
