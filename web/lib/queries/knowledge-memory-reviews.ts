import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "@/lib/brain/knowledge-access";
import type { Db } from "@/lib/execution-host/db";

import { createHash } from "node:crypto";

import { cache } from "react";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { unavailableMemory } from "@/lib/agent-memory-vault/store";
import { projectRolesForActions } from "@/lib/authz";
import { isBrainSchemaApplied } from "@/lib/brain/guard";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { projectContextReadPolicy } from "@/lib/brain/knowledge-context-policy";
import { knowledgeProposalReadPolicyCte } from "@/lib/brain/knowledge-proposal-query";
import { knowledgeSourceReadPolicy } from "@/lib/brain/knowledge-query-policy";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";

const kinds = z.enum(["vault", "brain", "knowledge"]);
const identity = z
  .string()
  .min(1)
  .max(192)
  .refine((value) => value.isWellFormed() && !value.includes("\0"));
const filters = z.strictObject({
  kind: kinds.optional(),
  projectId: identity.optional(),
  companyId: identity.optional(),
  agentId: identity.optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.number().max(100))
    .prefault("20"),
  cursor: z.string().min(1).max(2048).optional(),
});
const reviewSelector = z.strictObject({ kind: kinds, id: identity });
const batch = z.strictObject({
  items: z
    .array(
      reviewSelector
        .extend({
          expectedVersion: z.string().min(1).max(128),
          decision: z.enum(["accept", "reject"]),
          requestKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
          reason: z
            .string()
            .trim()
            .min(1)
            .max(2000)
            .refine((value) => value.isWellFormed() && !value.includes("\0"))
            .optional(),
        })
        .refine(
          (item) => item.kind !== "knowledge" || item.reason !== undefined,
        ),
    )
    .min(1)
    .max(50),
});
const cursorSchema = z.strictObject({
  kind: kinds,
  id: identity,
  scope: z.string().length(64),
  at: z.iso.datetime({ offset: true }),
});
const namespace = "maister.inbox.proposal-reviews.v1";

export type ReviewKind = z.infer<typeof kinds>;
export type ReviewFilter = z.infer<typeof filters>;
export type ReviewSelector = z.infer<typeof reviewSelector>;
export type ReviewDecision = z.infer<typeof batch>["items"][number];
type ReviewActor = Extract<KnowledgePrincipalIdentity, { kind: "user" }>;
type ReviewRow = Readonly<{
  kind: ReviewKind;
  id: string;
  version: string;
  title: string;
  allowed: ("accept" | "reject")[];
  at: string;
  project_id: string | null;
  company_id: string | null;
  agent_id: string | null;
}>;

function validate<T>(candidate: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(candidate);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid Inbox review selection");

  return parsed.data;
}

export function parseReviewFilters(candidate: unknown): ReviewFilter {
  return validate(candidate, filters);
}
export function parseReviewSelector(candidate: unknown): ReviewSelector {
  return validate(candidate, reviewSelector);
}
export function parseReviewBatch(candidate: unknown) {
  return validate(candidate, batch);
}

function projectRole(
  actor: ReviewActor,
  projectId: SQL,
  action: "writeBrain" | "manageCatalog" | "editSettings",
) {
  if (actor.user.role === "admin") return sql`true`;
  const roles = sql.join(
    projectRolesForActions([action]).map((value) => sql`${value}`),
    sql`, `,
  );

  return sql`EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=${projectId}
    AND m.user_id=${actor.user.id} AND m.role IN (${roles}))`;
}

function vaultSourcePolicy(actor: ReviewActor, brainReady: boolean): SQL {
  if (!brainReady)
    return sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(vp.source_restrictions) ref
      WHERE (ref->>'kind' NOT IN ('project_context','legacy_project_private') OR ref->>'projectId' IS DISTINCT FROM v.project_id))`;

  return sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(vp.source_restrictions) ref
    WHERE NOT (CASE WHEN ref->>'kind'='legacy_project_private' THEN ${projectContextReadPolicy(actor, sql`ref->>'projectId'`)}
      ELSE ${knowledgeSourceReadPolicy(actor, sql`ref`)} END))`;
}

async function reviewPolicy(tx: Db, userId: string) {
  await tx.execute(sql`SET LOCAL jit=off`);
  const principal = { kind: "user", userId } as const;
  const actor = await resolveKnowledgePrincipal(
    tx,
    principal,
    "knowledge:review",
  );

  if (actor.kind !== "user") throw unavailableMemory();
  const ready = await isBrainSchemaApplied(tx);
  const knowledge = ready
    ? knowledgeProposalReadPolicyCte(actor, principal, sql`p.status='pending'`)
    : sql`WITH`;
  const other = ready
    ? sql`
    UNION ALL
    SELECT 'brain', bp.id, bp.updated_at::text, left(coalesce(nullif(bp.draft->>'title',''),bp.kind),512),
      CASE WHEN bp.kind IN ('rule','flow','skill') AND NOT (${projectRole(actor, sql`bp.project_id`, "manageCatalog")})
      THEN ARRAY['reject'] ELSE ARRAY['accept','reject'] END,
      bp.created_at,bp.project_id,bp.company_id,NULL::text
    FROM brain_proposals bp JOIN projects p ON p.id=bp.project_id AND p.archived_at IS NULL
    WHERE bp.status='pending' AND bp.kind NOT IN ('knowledge_add','knowledge_correct')
      AND ${projectRole(actor, sql`p.id`, "writeBrain")}
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(bp.source_restrictions,'[]'::jsonb)) ref
        WHERE NOT (${knowledgeSourceReadPolicy(actor, sql`ref`)}))
    UNION ALL
    SELECT 'knowledge', id, revision::text, left(draft->>'title',512),ARRAY['accept','reject'],created_at,project_id,company_id,NULL::text
    FROM knowledge_readable_proposals WHERE inspection_action='review'`
    : sql``;

  return sql`${knowledge}${ready ? sql`,` : sql``} current_reviews(kind,id,version,title,allowed,created_at,project_id,company_id,agent_id) AS (
    SELECT 'vault', vp.id, vp.version::text, vp.changes->0->>'path',
      CASE WHEN (l.enabled AND l.memory_enabled) OR (reviewed.snapshot->'installationGrant'->>'memoryEnabled'='true')
           THEN ARRAY['accept','reject'] ELSE ARRAY['reject'] END,
      vp.created_at,v.project_id,v.company_id,v.agent_id
    FROM agent_memory_proposals vp
    JOIN agent_memory_vaults v ON v.id=vp.vault_id
    LEFT JOIN projects p ON p.id=v.project_id AND p.archived_at IS NULL
    LEFT JOIN agent_project_links l ON l.project_id=v.project_id AND l.agent_id=v.agent_id
    LEFT JOIN company_specialist_bindings b ON b.company_id=v.company_id AND b.agent_id=v.agent_id AND b.detached_at IS NULL
    LEFT JOIN company_specialist_binding_revisions reviewed ON (reviewed.binding_id,reviewed.revision)=(b.id,b.revision)
    WHERE vp.state='pending' AND (
      (p.id IS NOT NULL AND l.project_id IS NOT NULL AND ${projectRole(actor, sql`p.id`, "editSettings")}
        AND NOT EXISTS (SELECT 1 FROM unnest(vp.source_project_ids) source_id WHERE source_id IS DISTINCT FROM p.id))
      OR (v.company_id IS NOT NULL AND ${actor.user.role === "admin"}
        AND reviewed.snapshot->'installationGrant'->>'reach'='active_projects'))
      AND EXISTS (SELECT 1 FROM agent_memory_cutover)
      AND NOT EXISTS (SELECT 1 FROM agent_memory_operation_revisions refs
         JOIN agent_memory_redactions r ON (r.vault_id,r.note_id,r.revision_id)=(refs.vault_id,refs.note_id,refs.revision_id)
         WHERE refs.vault_id=v.id AND refs.operation_id=vp.operation_id)
      AND ${vaultSourcePolicy(actor, ready)}${other}
  )`;
}

function reviewItem(row: ReviewRow) {
  return {
    kind: row.kind,
    id: row.id,
    version: row.version,
    title: row.title,
    allowed: row.allowed,
    createdAt: row.at,
  };
}

const columns = sql`kind,id,version,title,allowed,project_id,company_id,agent_id,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;

export async function listProposalReviews(
  db: Db,
  userId: string,
  selection: ReviewFilter,
) {
  const { cursor, ...filtersForScope } = selection;
  const scope = createHash("sha256")
    .update(JSON.stringify([userId, filtersForScope]))
    .digest("hex");
  const page =
    cursor === undefined
      ? null
      : validate(parseCursorPayload(namespace, cursor), cursorSchema);

  if (page && page.scope !== scope)
    throw new MaisterError(
      "CONFIG",
      "Review cursor belongs to another selection",
    );

  return db.transaction(async (tx) => {
    const policy = await reviewPolicy(tx, userId);
    const { rows } =
      await tx.execute<ReviewRow>(sql`${policy} SELECT ${columns} FROM current_reviews
      WHERE ${selection.kind ? sql`kind=${selection.kind}` : sql`true`}
        ${selection.projectId ? sql`AND project_id=${selection.projectId}` : sql``}
        ${selection.companyId ? sql`AND company_id=${selection.companyId}` : sql``}
        ${selection.agentId ? sql`AND agent_id=${selection.agentId}` : sql``}
        ${page ? sql`AND (created_at,kind,id)<(${page.at}::timestamptz,${page.kind},${page.id})` : sql``}
      ORDER BY created_at DESC,kind DESC,id DESC LIMIT ${selection.limit + 1}`);
    const selected = rows.slice(0, selection.limit);
    const last = selected.at(-1);

    return {
      items: selected.map(reviewItem),
      nextCursor:
        last && rows.length > selection.limit
          ? signCursorPayload(namespace, {
              kind: last.kind,
              id: last.id,
              at: last.at,
              scope,
            })
          : null,
    };
  });
}

export async function readProposalReviewMetadata(
  tx: Db,
  userId: string,
  selection: ReviewSelector,
) {
  const policy = await reviewPolicy(tx, userId);
  const [row] = (
    await tx.execute<ReviewRow>(sql`${policy} SELECT ${columns} FROM current_reviews
    WHERE kind=${selection.kind} AND id=${selection.id}`)
  ).rows;

  if (!row) throw unavailableMemory();

  return { ...reviewItem(row), projectId: row.project_id };
}

export async function readProposalReviewCounter(db: Db, userId: string) {
  return db.transaction(async (tx) => {
    const policy = await reviewPolicy(tx, userId);
    const [row] = (
      await tx.execute<{ reviews: number; reviewVersion: string }>(sql`${policy}
      SELECT count(*)::int AS reviews, encode(sha256(convert_to(coalesce(
         string_agg(jsonb_build_array(kind,id,version,title,allowed)::text,E'\\n' ORDER BY kind,id),''),'UTF8')),'hex') AS "reviewVersion"
      FROM current_reviews`)
    ).rows;

    if (!row) throw new MaisterError("CRASH", "Review counter was unavailable");

    return row;
  });
}

export const getProposalReviewCounter = cache((userId: string) =>
  readProposalReviewCounter(getDb(), userId),
);
