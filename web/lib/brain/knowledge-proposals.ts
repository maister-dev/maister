import "server-only";

import type { KnowledgeAccessRestriction, Owner } from "@/lib/company/types";
import type { KnowledgeAttribution } from "./record-types";
import type {
  CreateKnowledgeProposalInput,
  KnowledgeDraft,
  KnowledgePrincipal,
  KnowledgeProposalDto,
  KnowledgeAction,
} from "./knowledge-types";
import type {
  KnowledgeDatabase,
  KnowledgeTransaction,
  KnowledgeAuthority,
  KnowledgeAuthorityActor,
} from "./knowledge-access";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";

import { authorizeKnowledge, knowledgeOwner } from "./knowledge-access";
import {
  knowledgeDraftSchema,
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "./knowledge-types";
import { sha256 } from "./codec";
import {
  knowledgeProposalDecisionSchema,
  knowledgeConfirmationInputSchema,
} from "./knowledge-write-types";
import { inspectKnowledgeWitness } from "./knowledge-witnesses";
import {
  additionalKnowledgeRestrictions,
  lockKnowledgeReadConsumer,
} from "./knowledge-disclosure";
import {
  authorizeKnowledgeRecordRead,
  authorizeSourceRestrictions,
  parseKnowledgeRestrictions,
  authorizeKnowledgeRevisionRead,
} from "./knowledge-restrictions";

import { postgresTextSchema } from "@/lib/text-schema";
import { ownerSchema } from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { redactQueryError } from "@/lib/db/pg-error";
import { emitKnowledgeRecordChange } from "@/lib/domain-events/outbox";

const log = pino({
  name: "brain:knowledge",
  level: process.env.LOG_LEVEL ?? "info",
});

type StoredProposal = Record<string, unknown>;
type WitnessLink = Readonly<{
  relation: KnowledgeDraft["evidence"][number]["relation"];
  id: string;
  snapshot: Record<string, unknown>;
}>;
export type KnowledgeProposalReceipt = Pick<
  KnowledgeProposalDto,
  | "id"
  | "owner"
  | "revision"
  | "status"
  | "acceptedRecordId"
  | "acceptedRecordRevision"
> &
  Readonly<{ duplicate: boolean }>;

function receipt(row: StoredProposal): KnowledgeProposalReceipt {
  return {
    duplicate: false,
    id: String(row.id),
    owner: knowledgeOwner(row),
    revision: Number(row.revision),
    status: row.status as KnowledgeProposalDto["status"],
    acceptedRecordId: row.published_record_id as string | null,
    acceptedRecordRevision: row.published_record_revision as number | null,
  };
}

function replayedReceipt(row: StoredProposal): KnowledgeProposalReceipt {
  return { ...receipt(row), duplicate: true };
}

async function retainSubmission(
  tx: KnowledgeTransaction,
  input: Readonly<{
    owner: Owner;
    proposalId: string;
    principalKey: string;
    key: string;
    digest: string;
    actor: KnowledgeAttribution;
  }>,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO brain_knowledge_submissions(project_id,company_id,proposal_id,principal_key,delivery_key,request_digest,attribution) VALUES(${input.owner.kind === "project" ? input.owner.projectId : null},${input.owner.kind === "company" ? input.owner.companyId : null},${input.proposalId},${input.principalKey},${input.key},${input.digest},${JSON.stringify(input.actor)}::jsonb)`,
  );
}

function validKey(key: string): void {
  if (!knowledgeDeliveryKeySchema.safeParse(key).success)
    throw new MaisterError(
      "CONFIG",
      "A bounded knowledge delivery key is required",
    );
}

async function recordAccess(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  recordId: string,
  action: KnowledgeAction,
): Promise<{ row: Record<string, unknown>; authority: KnowledgeAuthority }> {
  const row = (
    await tx.execute(
      sql`SELECT * FROM brain_items WHERE id=${recordId} FOR UPDATE`,
    )
  ).rows[0];

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "Knowledge reference is unavailable",
      { details: { reason: "knowledge_reference_unavailable" } },
    );
  await authorizeKnowledgeRecordRead(tx, principal, recordId);
  const authority = await authorizeKnowledge(
    tx,
    principal,
    knowledgeOwner(row),
    action,
  );

  if (row.visibility === "restricted") {
    const grant = (
      await tx.execute(
        sql`SELECT id FROM brain_record_grants WHERE record_id=${recordId} AND principal_type=${authority.actor.kind} AND principal_id=${authority.actor.id} AND action=${action} AND revoked_at IS NULL FOR SHARE`,
      )
    ).rows[0];

    if (!grant)
      throw new MaisterError(
        "PRECONDITION",
        "Knowledge reference is unavailable",
        { details: { reason: "knowledge_reference_unavailable" } },
      );
  }

  return { row, authority };
}

async function witness(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  id: string,
): Promise<Record<string, unknown>> {
  const row = (
    await tx.execute(sql`
    SELECT w.id,w.source_version,w.content_sha256,w.selector,w.restrictions,o.source_id,o.project_id,o.company_id
    FROM brain_evidence_witnesses w JOIN brain_evidence_observations o ON o.id=w.observation_id WHERE w.id=${id} FOR SHARE OF w,o
  `)
  ).rows[0];

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "Evidence reference is unavailable",
      { details: { reason: "knowledge_reference_unavailable" } },
    );
  await authorizeSourceRestrictions(tx, principal, [knowledgeOwner(row)]);
  await authorizeSourceRestrictions(tx, principal, row.restrictions);

  return row;
}

async function evidenceLinks(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  draft: KnowledgeDraft,
  owner: Owner,
): Promise<WitnessLink[]> {
  const links: WitnessLink[] = [];

  for (const entry of draft.evidence) {
    if (entry.reference.kind !== "witness")
      throw new MaisterError(
        "PRECONDITION",
        "This evidence kind requires its native reference resolver",
        { details: { reason: "native_reference_kind_unavailable" } },
      );
    if (entry.reference.revision !== undefined)
      throw new MaisterError(
        "CONFLICT",
        "Immutable witness references do not have record revisions",
      );
    const row = await witness(tx, principal, entry.reference.id);

    if (
      (entry.reference.sha256 !== undefined &&
        entry.reference.sha256 !== row.content_sha256) ||
      (entry.reference.version !== undefined &&
        entry.reference.version !== row.source_version)
    )
      throw new MaisterError(
        "CONFLICT",
        "Evidence version does not match its immutable witness",
      );
    links.push({
      relation: entry.relation,
      id: String(row.id),
      snapshot: {
        id: row.id,
        sourceId: row.source_id,
        sourceVersion: row.source_version,
        sha256: row.content_sha256,
        selector: row.selector,
        restrictions: additionalKnowledgeRestrictions(owner, [
          knowledgeOwner(row),
          ...(parseKnowledgeRestrictions(row.restrictions) ?? []),
        ]),
      },
    });
  }

  return links;
}

async function nativeProposal(
  tx: KnowledgeTransaction,
  proposalId: string,
): Promise<StoredProposal> {
  const row = (
    await tx.execute(
      sql`SELECT * FROM brain_proposals WHERE id=${proposalId} AND kind IN ('knowledge_add','knowledge_correct') FOR UPDATE`,
    )
  ).rows[0];

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "Knowledge proposal is unavailable",
      { details: { reason: "knowledge_reference_unavailable" } },
    );

  return row;
}

function canonicalKnowledgeDraft(draft: KnowledgeDraft): KnowledgeDraft {
  const evidence = new Map(
    draft.evidence.map((entry) => [contentDigest(entry), entry]),
  );
  const missing = new Map(
    draft.missingEvidence.map((entry) => [contentDigest(entry), entry]),
  );

  return {
    ...draft,
    evidence: [...evidence.keys()].sort().map((key) => evidence.get(key)!),
    missingEvidence: [...missing.keys()].sort().map((key) => missing.get(key)!),
    limitations: [...new Set(draft.limitations)].sort(),
  };
}

export async function createKnowledgeProposal(
  db: KnowledgeDatabase,
  input: CreateKnowledgeProposalInput,
): Promise<KnowledgeProposalReceipt> {
  validKey(input.idempotencyKey);
  const owner = ownerSchema.safeParse(input.owner);
  const parsed = knowledgeDraftSchema.safeParse(input.draft);

  if (!owner.success || !parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Knowledge proposal does not match its native contract",
    );
  if (input.kind === "knowledge_correct") {
    if (
      !postgresTextSchema.min(1).max(128).safeParse(input.targetRecordId)
        .success ||
      !knowledgeRevisionSchema.safeParse(input.expectedRecordRevision).success
    )
      throw new MaisterError(
        "CONFIG",
        "A correction requires an exact bounded record revision",
      );
  } else if (
    input.targetRecordId !== undefined ||
    input.expectedRecordRevision !== undefined
  ) {
    throw new MaisterError(
      "CONFIG",
      "A knowledge addition cannot specify a correction target",
    );
  }
  const draft = canonicalKnowledgeDraft(parsed.data);
  const digest = contentDigest({
    kind: input.kind,
    owner: owner.data,
    draft: draft,
    target: input.targetRecordId ?? null,
    base: input.expectedRecordRevision ?? null,
  });

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const consumer = await lockKnowledgeReadConsumer(tx, input.principal);
      const authority = await authorizeKnowledge(
        tx,
        input.principal,
        owner.data,
        "knowledge:propose",
      );
      const principalKey = `${authority.actor.kind}:${authority.actor.id}`;
      const ownerId =
        owner.data.kind === "company"
          ? owner.data.companyId
          : owner.data.projectId;

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge:${owner.data.kind}:${ownerId}:${principalKey}`},0))`,
      );
      const prior = (
        await tx.execute(
          sql`SELECT p.* FROM brain_knowledge_submissions s JOIN brain_proposals p ON p.id=s.proposal_id WHERE s.project_id IS NOT DISTINCT FROM ${owner.data.kind === "project" ? owner.data.projectId : null} AND s.company_id IS NOT DISTINCT FROM ${owner.data.kind === "company" ? owner.data.companyId : null} AND s.principal_key=${principalKey} AND s.delivery_key=${input.idempotencyKey}`,
        )
      ).rows[0];

      if (prior && prior.request_digest !== digest)
        throw new MaisterError(
          "CONFLICT",
          "Knowledge delivery key already names different input",
        );
      const links = await evidenceLinks(tx, input.principal, draft, owner.data);
      let restrictions = additionalKnowledgeRestrictions(owner.data, [
        ...(consumer?.capture.restrictions ?? []),
        ...links.flatMap(
          (link) =>
            parseKnowledgeRestrictions(link.snapshot.restrictions) ?? [],
        ),
      ]);

      if (prior)
        await authorizeSourceRestrictions(
          tx,
          input.principal,
          prior.source_restrictions,
        );
      if (prior) return replayedReceipt(prior);
      let correctionHead: number | null = null;

      if (input.targetRecordId !== undefined) {
        const target = await recordAccess(
          tx,
          input.principal,
          input.targetRecordId,
          "knowledge:propose",
        );

        await authorizeKnowledgeRevisionRead(
          tx,
          input.principal,
          input.targetRecordId,
          input.expectedRecordRevision!,
        );
        const base = (
          await tx.execute(
            sql`SELECT source_restrictions FROM brain_record_revisions WHERE record_id=${input.targetRecordId} AND revision=${input.expectedRecordRevision!}`,
          )
        ).rows[0];

        if (
          contentDigest(knowledgeOwner(target.row)) !==
          contentDigest(owner.data)
        )
          throw new MaisterError(
            "CONFLICT",
            "Knowledge correction owner does not match its record",
          );
        correctionHead = Number(target.row.current_revision);
        restrictions = additionalKnowledgeRestrictions(owner.data, [
          ...restrictions,
          ...(parseKnowledgeRestrictions(base.source_restrictions) ?? []),
          { kind: "record", recordId: input.targetRecordId },
        ]);
      }
      await authorizeSourceRestrictions(tx, input.principal, restrictions);
      const identical = (
        await tx.execute(
          sql`SELECT * FROM brain_proposals WHERE project_id IS NOT DISTINCT FROM ${owner.data.kind === "project" ? owner.data.projectId : null} AND company_id IS NOT DISTINCT FROM ${owner.data.kind === "company" ? owner.data.companyId : null} AND principal_key=${principalKey} AND request_digest=${digest} AND source_restrictions IS NOT DISTINCT FROM ${JSON.stringify(restrictions)}::jsonb`,
        )
      ).rows[0];

      if (identical) {
        await retainSubmission(tx, {
          owner: owner.data,
          proposalId: String(identical.id),
          principalKey,
          key: input.idempotencyKey,
          digest,
          actor: authority.actor,
        });

        return replayedReceipt(identical);
      }
      if (
        correctionHead !== null &&
        correctionHead !== input.expectedRecordRevision
      )
        throw new MaisterError(
          "CONFLICT",
          "Knowledge correction base is stale",
        );
      const id = randomUUID();
      const row = (
        await tx.execute(sql`
        INSERT INTO brain_proposals(id,project_id,company_id,kind,draft,actor,run_id,principal_key,submission_key,request_digest,knowledge_attribution,target_record_id,expected_record_revision,authority_snapshot,source_restrictions)
        VALUES(${id},${owner.data.kind === "project" ? owner.data.projectId : null},${owner.data.kind === "company" ? owner.data.companyId : null},${input.kind},${JSON.stringify(draft)}::jsonb,${JSON.stringify({ type: authority.actor.kind, id: authority.actor.id })}::jsonb,${authority.actor.runId},${principalKey},${input.idempotencyKey},${digest},${JSON.stringify(authority.actor)}::jsonb,${input.targetRecordId ?? null},${input.expectedRecordRevision ?? null},${JSON.stringify({ submit: authority.policy })}::jsonb,${JSON.stringify(restrictions)}::jsonb)
        RETURNING *
      `)
      ).rows[0];

      if (!row)
        throw new MaisterError("CRASH", "Knowledge proposal was not retained");
      await retainSubmission(tx, {
        owner: owner.data,
        proposalId: id,
        principalKey,
        key: input.idempotencyKey,
        digest,
        actor: authority.actor,
      });
      log.info(
        {
          proposalId: id,
          ownerKind: owner.data.kind,
          ownerId,
          actorId: authority.actor.id,
        },
        "knowledge proposed",
      );

      return receipt(row);
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

type PublishedRecord = Readonly<{ recordId: string; revision: number }>;

async function identicalPublication(
  tx: KnowledgeTransaction,
  owner: Owner,
  draft: KnowledgeDraft,
  links: readonly WitnessLink[],
  restrictions: readonly KnowledgeAccessRestriction[],
): Promise<PublishedRecord | null> {
  const row = (
    await tx.execute(sql`
    SELECT i.id,i.current_revision,r.title,r.assertion,r.kind,r.basis,r.limitations,r.missing_evidence FROM brain_items i
    JOIN brain_record_revisions r ON r.record_id=i.id AND r.revision=i.current_revision
    WHERE i.project_id IS NOT DISTINCT FROM ${owner.kind === "project" ? owner.projectId : null}
      AND i.company_id IS NOT DISTINCT FROM ${owner.kind === "company" ? owner.companyId : null}
      AND i.source_restrictions IS NOT DISTINCT FROM ${JSON.stringify(restrictions)}::jsonb AND i.content_hash=${sha256(draft.assertion)} AND i.status='active' AND i.visibility='owner_grants' FOR UPDATE OF i
  `)
  ).rows[0];

  if (!row) return null;
  const evidence = (
    await tx.execute(
      sql`SELECT witness_id,relation FROM brain_revision_evidence WHERE record_id=${row.id} AND revision=${row.current_revision}`,
    )
  ).rows;
  const expectedEvidence = links
    .map((link) => `${link.id}:${link.relation}`)
    .sort();
  const actualEvidence = evidence
    .map((entry) => `${entry.witness_id}:${entry.relation}`)
    .sort();

  if (
    row.title !== draft.title ||
    row.assertion !== draft.assertion ||
    row.kind !== draft.kind ||
    row.basis !== draft.basis ||
    contentDigest(row.limitations) !== contentDigest(draft.limitations) ||
    contentDigest(row.missing_evidence) !==
      contentDigest(draft.missingEvidence) ||
    contentDigest(actualEvidence) !== contentDigest(expectedEvidence)
  )
    throw new MaisterError(
      "CONFLICT",
      "An accessible assertion already exists with different metadata; propose a correction",
    );

  return { recordId: String(row.id), revision: Number(row.current_revision) };
}

async function writeKnowledgeRevision(
  tx: KnowledgeTransaction,
  input: Readonly<{
    owner: Owner;
    draft: KnowledgeDraft;
    links: readonly WitnessLink[];
    proposalId: string;
    attribution: KnowledgeAttribution;
    reviewer: KnowledgeAuthorityActor;
    recordId: string;
    revision: number;
    priorRevision: number | null;
    restrictions: readonly KnowledgeAccessRestriction[];
  }>,
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('maister.knowledge_writer','native_v1',true)`,
  );
  if (input.priorRevision === null) {
    await tx.execute(
      sql`INSERT INTO brain_items(id,project_id,company_id,current_revision,kind,title,content,confidence,content_hash,source_run_id,source_restrictions) VALUES(${input.recordId},${input.owner.kind === "project" ? input.owner.projectId : null},${input.owner.kind === "company" ? input.owner.companyId : null},${input.revision},${input.draft.kind},${input.draft.title},${input.draft.assertion},0.3,${sha256(input.draft.assertion)},${input.attribution.runId},${JSON.stringify(input.restrictions)}::jsonb)`,
    );
  } else {
    await tx.execute(
      sql`UPDATE brain_items SET source_restrictions=${JSON.stringify(input.restrictions)}::jsonb,current_revision=${input.revision},kind=${input.draft.kind},title=${input.draft.title},content=${input.draft.assertion},content_hash=${sha256(input.draft.assertion)},updated_at=now() WHERE id=${input.recordId}`,
    );
  }
  await tx.execute(
    sql`INSERT INTO brain_record_revisions(record_id,revision,assertion,title,kind,basis,content_sha256,attribution,freshness,limitations,missing_evidence,proposal_id,provenance,source_restrictions) VALUES(${input.recordId},${input.revision},${input.draft.assertion},${input.draft.title},${input.draft.kind},${input.draft.basis},${sha256(input.draft.assertion)},${JSON.stringify(input.attribution)}::jsonb,${JSON.stringify({ state: "unknown", applicability: "unknown", observedAt: null, sourceAt: null, capturedAt: new Date().toISOString() })}::jsonb,${JSON.stringify(input.draft.limitations)}::jsonb,${JSON.stringify(input.draft.missingEvidence)}::jsonb,${input.proposalId},'submitted',${JSON.stringify(input.restrictions)}::jsonb)`,
  );
  for (const link of input.links)
    await tx.execute(
      sql`INSERT INTO brain_revision_evidence(record_id,revision,witness_id,relation,witness_snapshot) VALUES(${input.recordId},${input.revision},${link.id},${link.relation},${JSON.stringify(link.snapshot)}::jsonb) ON CONFLICT DO NOTHING`,
    );
  const change = (
    await tx.execute(
      sql`INSERT INTO brain_record_changes(record_id,prior_revision,accepted_revision,proposal_id,actor,originating_work) VALUES(${input.recordId},${input.priorRevision},${input.revision},${input.proposalId},${JSON.stringify(input.reviewer)}::jsonb,${JSON.stringify({ runId: input.attribution.runId })}::jsonb) RETURNING id`,
    )
  ).rows[0];

  if (typeof change?.id !== "string")
    throw new MaisterError(
      "CRASH",
      "Knowledge change identity was not retained",
    );
  await emitKnowledgeRecordChange({
    db: tx,
    owner: input.owner,
    recordId: input.recordId,
    revision: input.revision,
    changeId: change.id,
    cause: "published",
    actor: {
      type: input.reviewer.kind,
      id: input.reviewer.id,
    },
  });
  log.info(
    {
      recordId: input.recordId,
      revision: input.revision,
      priorRevision: input.priorRevision,
      proposalId: input.proposalId,
      actorId: input.reviewer.id,
    },
    "knowledge revision published",
  );
}

async function acceptKnowledgeProposal(
  tx: KnowledgeTransaction,
  input: Readonly<{
    proposal: StoredProposal;
    owner: Owner;
    draft: KnowledgeDraft;
    links: readonly WitnessLink[];
    principal: KnowledgePrincipal;
    reviewer: KnowledgeAuthorityActor;
    restrictions: readonly KnowledgeAccessRestriction[];
  }>,
): Promise<PublishedRecord> {
  let recordId: string = randomUUID();
  let priorRevision: number | null = null;

  if (input.proposal.kind === "knowledge_correct") {
    const target = await recordAccess(
      tx,
      input.principal,
      String(input.proposal.target_record_id),
      "knowledge:review",
    );

    await recordAccess(
      tx,
      input.principal,
      String(input.proposal.target_record_id),
      "knowledge:read",
    );
    if (
      contentDigest(knowledgeOwner(target.row)) !==
        contentDigest(input.owner) ||
      Number(target.row.current_revision) !==
        Number(input.proposal.expected_record_revision)
    )
      throw new MaisterError("CONFLICT", "Knowledge correction base is stale");
    recordId = String(target.row.id);
    priorRevision = Number(target.row.current_revision);
  } else {
    const identical = await identicalPublication(
      tx,
      input.owner,
      input.draft,
      input.links,
      input.restrictions,
    );

    if (identical) return identical;
  }
  const revision = priorRevision === null ? 1 : priorRevision + 1;

  await writeKnowledgeRevision(tx, {
    ...input,
    proposalId: String(input.proposal.id),
    attribution: input.proposal.knowledge_attribution as KnowledgeAttribution,
    recordId,
    revision,
    priorRevision,
  });

  return { recordId, revision };
}

export async function reviewKnowledgeProposal(
  db: KnowledgeDatabase,
  input: Readonly<{
    proposalId: string;
    principal: KnowledgePrincipal;
    expectedRevision: number;
    decision: "accept" | "reject";
    reason: string;
    idempotencyKey: string;
  }>,
): Promise<KnowledgeProposalReceipt> {
  if (
    !postgresTextSchema.min(1).max(128).safeParse(input.proposalId).success ||
    !knowledgeProposalDecisionSchema.safeParse({
      expectedRevision: input.expectedRevision,
      decision: input.decision,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    }).success
  )
    throw new MaisterError(
      "CONFIG",
      "Invalid exact-revision knowledge review decision",
    );
  const digest = contentDigest({
    revision: input.expectedRevision,
    decision: input.decision,
    reason: input.reason,
  });

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      await lockKnowledgeReadConsumer(tx, input.principal);
      const proposal = await nativeProposal(tx, input.proposalId);
      const owner = knowledgeOwner(proposal);
      const authority = await authorizeKnowledge(
        tx,
        input.principal,
        owner,
        "knowledge:review",
      );

      await authorizeKnowledge(tx, input.principal, owner, "knowledge:read");
      if (proposal.status !== "pending") {
        await authorizeSourceRestrictions(
          tx,
          input.principal,
          proposal.source_restrictions,
        );
        if (
          proposal.decision_key === input.idempotencyKey &&
          proposal.decision_digest === digest
        )
          return replayedReceipt(proposal);
        throw new MaisterError(
          "CONFLICT",
          "Knowledge proposal already has a different decision",
        );
      }
      if (Number(proposal.revision) !== input.expectedRevision)
        throw new MaisterError(
          "CONFLICT",
          "Knowledge proposal revision is stale",
        );
      const parsed = knowledgeDraftSchema.safeParse(proposal.draft);

      if (!parsed.success)
        throw new MaisterError(
          "CONFIG",
          "Stored knowledge proposal does not match its contract",
        );
      if (input.decision === "accept") {
        const ownerId =
          owner.kind === "company" ? owner.companyId : owner.projectId;

        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-publication:${owner.kind}:${ownerId}:${sha256(parsed.data.assertion)}`},0))`,
        );
        if (proposal.kind === "knowledge_correct")
          await recordAccess(
            tx,
            input.principal,
            String(proposal.target_record_id),
            "knowledge:review",
          );
      }
      await authorizeSourceRestrictions(
        tx,
        input.principal,
        proposal.source_restrictions,
      );
      let publication: PublishedRecord | null = null;

      if (input.decision === "accept") {
        const links = await evidenceLinks(
          tx,
          input.principal,
          parsed.data,
          owner,
        );

        publication = await acceptKnowledgeProposal(tx, {
          proposal,
          owner,
          draft: parsed.data,
          links,
          principal: input.principal,
          reviewer: authority.actor,
          restrictions: additionalKnowledgeRestrictions(owner, [
            ...(parseKnowledgeRestrictions(proposal.source_restrictions) ?? []),
            ...links.flatMap(
              (link) =>
                parseKnowledgeRestrictions(link.snapshot.restrictions) ?? [],
            ),
          ]),
        });
      }
      const recordId = publication?.recordId ?? null;
      const recordRevision = publication?.revision ?? null;
      const row = (
        await tx.execute(
          sql`UPDATE brain_proposals SET status=${input.decision === "accept" ? "accepted" : "rejected"},revision=revision+1,decision_key=${input.idempotencyKey},decision_digest=${digest},published_record_id=${recordId},published_record_revision=${recordRevision},resolution=${JSON.stringify({ actor: authority.actor, reason: input.reason })}::jsonb,authority_snapshot=authority_snapshot || ${JSON.stringify({ review: authority.policy })}::jsonb,resolved_at=now(),updated_at=now() WHERE id=${input.proposalId} RETURNING *`,
        )
      ).rows[0];

      if (!row)
        throw new MaisterError("CRASH", "Knowledge decision was not retained");

      log.info(
        {
          proposalId: input.proposalId,
          decision: input.decision,
          expectedRevision: input.expectedRevision,
          policyId: authority.policy.authorityId,
          recordId,
        },
        "knowledge proposal reviewed",
      );

      return receipt(row);
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

export async function confirmKnowledgeRecord(
  db: KnowledgeDatabase,
  input: Readonly<{
    recordId: string;
    principal: KnowledgePrincipal;
    expectedRevision: number;
    decision: "confirm" | "revoke";
    witnessIds: readonly string[];
    reason: string;
    idempotencyKey: string;
  }>,
): Promise<{
  id: string;
  revision: number;
  status: "confirmed" | "revoked";
  duplicate: boolean;
}> {
  if (
    !postgresTextSchema.min(1).max(128).safeParse(input.recordId).success ||
    !knowledgeConfirmationInputSchema.safeParse({
      expectedRevision: input.expectedRevision,
      decision: input.decision,
      witnessIds: input.witnessIds,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    }).success
  )
    throw new MaisterError(
      "CONFIG",
      "Invalid exact-revision knowledge confirmation decision",
    );
  const digest = contentDigest({
    revision: input.expectedRevision,
    decision: input.decision,
    witnessIds: [...new Set(input.witnessIds)].sort(),
    reason: input.reason,
  });

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      await lockKnowledgeReadConsumer(tx, input.principal);
      const current = await recordAccess(
        tx,
        input.principal,
        input.recordId,
        "knowledge:confirm",
      );

      await recordAccess(tx, input.principal, input.recordId, "knowledge:read");
      const prior = (
        await tx.execute(
          sql`SELECT id,record_revision,decision,request_digest FROM brain_confirmations WHERE record_id=${input.recordId} AND idempotency_key=${input.idempotencyKey}`,
        )
      ).rows[0];

      if (prior) {
        if (prior.request_digest !== digest)
          throw new MaisterError(
            "CONFLICT",
            "Confirmation delivery key already names a different decision",
          );

        return {
          duplicate: true,
          id: String(prior.id),
          revision: Number(prior.record_revision),
          status: prior.decision === "confirm" ? "confirmed" : "revoked",
        };
      }
      if (Number(current.row.current_revision) !== input.expectedRevision)
        throw new MaisterError(
          "CONFLICT",
          "Confirmation record revision is stale",
        );
      const revision = (
        await tx.execute(
          sql`SELECT attribution FROM brain_record_revisions WHERE record_id=${input.recordId} AND revision=${input.expectedRevision}`,
        )
      ).rows[0];

      if (
        current.authority.actor.kind !== "user" &&
        (!current.authority.policy.confirmationClasses.includes(
          String(current.row.kind),
        ) ||
          (revision?.attribution as KnowledgeAttribution | undefined)?.id ===
            current.authority.actor.id)
      )
        throw new MaisterError(
          "UNAUTHORIZED",
          "A separate explicitly authorized verifier is required",
        );
      const evidence: Record<string, unknown>[] = [];

      if (input.decision === "confirm") {
        if (input.witnessIds.length === 0)
          throw new MaisterError(
            "PRECONDITION",
            "Confirmation requires available supporting evidence",
          );
        for (const id of new Set(input.witnessIds)) {
          const linked = (
            await tx.execute(
              sql`SELECT witness_id FROM brain_revision_evidence WHERE record_id=${input.recordId} AND revision=${input.expectedRevision} AND witness_id=${id} AND relation='supports'`,
            )
          ).rows[0];

          if (!linked)
            throw new MaisterError(
              "PRECONDITION",
              "Confirmation evidence must support this exact assertion revision",
            );
          const inspection = await inspectKnowledgeWitness(
            tx,
            input.principal,
            id,
          );

          if (inspection.witness.availability !== "available")
            throw new MaisterError(
              "PRECONDITION",
              "Factual confirmation requires currently available supporting evidence",
              { details: { reason: "knowledge_evidence_unavailable" } },
            );
          evidence.push(await witness(tx, input.principal, id));
        }
      }
      const id = randomUUID();

      await tx.execute(
        sql`INSERT INTO brain_confirmations(id,record_id,record_revision,decision,confirmer,policy_snapshot,evidence_witnesses,reason,idempotency_key,request_digest) VALUES(${id},${input.recordId},${input.expectedRevision},${input.decision},${JSON.stringify(current.authority.actor)}::jsonb,${JSON.stringify(current.authority.policy)}::jsonb,${JSON.stringify(evidence)}::jsonb,${input.reason},${input.idempotencyKey},${digest})`,
      );
      await emitKnowledgeRecordChange({
        db: tx,
        owner: knowledgeOwner(current.row),
        recordId: input.recordId,
        revision: input.expectedRevision,
        changeId: id,
        cause: input.decision === "confirm" ? "confirmed" : "revoked",
        actor: {
          type: current.authority.actor.kind,
          id: current.authority.actor.id,
        },
      });
      log.info(
        {
          confirmationId: id,
          recordId: input.recordId,
          revision: input.expectedRevision,
          decision: input.decision,
          policyId: current.authority.policy.authorityId,
          evidenceCount: evidence.length,
        },
        "knowledge confirmation decided",
      );

      return {
        duplicate: false,
        id,
        revision: input.expectedRevision,
        status: input.decision === "confirm" ? "confirmed" : "revoked",
      };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
