import "server-only";

import type { SQL } from "drizzle-orm";
import type { ProjectAction } from "@/lib/authz";
import type { KnowledgePrincipalIdentity } from "@/lib/brain/knowledge-access";
import type { Db } from "@/lib/execution-host/db";
import type { PersonalKnowledgeCredential } from "@/lib/tokens/personal-knowledge";

import { createHash } from "node:crypto";

import { cache } from "react";
import { sql } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

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
import {
  lockPersonalKnowledgeCredential,
  visibleReviewKinds,
} from "@/lib/tokens/personal-knowledge";

const kinds = z.enum(["vault", "brain", "knowledge"]);
const identity = z
  .string()
  .min(1)
  .max(192)
  .refine((value) => value.isWellFormed() && !value.includes("\0"));
const filters = z
  .strictObject({
    view: z.enum(["pending", "history"]).optional(),
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
  })
  .refine((value) => !value.projectId || !value.companyId);
const reviewSelector = z.strictObject({ kind: kinds, id: identity });
const decisionInput = z.strictObject({
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
});
const batch = z.strictObject({
  items: z
    .array(
      reviewSelector
        .extend(decisionInput.shape)
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
const historyNamespace = "maister.inbox.proposal-reviews.history.v1";
const historyCursorSchema = cursorSchema.extend({
  upper: cursorSchema.shape.at,
});
const log = pino({
  name: "inbox-review-query",
  level: process.env.LOG_LEVEL ?? "info",
});

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
  owner_label: string;
  author: string | null;
  domain_state: string;
  outcome_available: boolean;
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

export function parseSingleReviewDecision(
  selector: ReviewSelector,
  candidate: unknown,
): ReviewDecision {
  const input = validate(candidate, decisionInput);

  if (
    (selector.kind === "knowledge" || input.decision === "reject") &&
    input.reason === undefined
  )
    throw new MaisterError(
      "CONFIG",
      "A reason is required for this review decision",
    );

  return { ...selector, ...input };
}

export function brainReviewActions(
  kind: string,
  decision: "accept" | "reject",
): readonly ProjectAction[] {
  if (decision === "reject") return ["writeBrain"];

  return [
    "writeBrain",
    ["rule", "flow", "skill"].includes(kind) ? "manageCatalog" : "createTask",
  ];
}

function projectRole(
  actor: ReviewActor,
  projectId: SQL,
  actions: readonly ProjectAction[],
) {
  if (actor.user.role === "admin") return sql`true`;
  const roles = sql.join(
    projectRolesForActions(actions).map((value) => sql`${value}`),
    sql`, `,
  );

  return sql`EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=${projectId}
    AND m.user_id=${actor.user.id} AND m.role IN (${roles}) FOR SHARE)`;
}

function vaultSourcePolicy(actor: ReviewActor, brainReady: boolean): SQL {
  if (!brainReady)
    return sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(vp.source_restrictions) ref
      WHERE (ref->>'kind' NOT IN ('project_context','legacy_project_private') OR ref->>'projectId' IS DISTINCT FROM v.project_id))`;

  return sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(vp.source_restrictions) ref
    WHERE NOT (CASE WHEN ref->>'kind'='legacy_project_private' THEN ${projectContextReadPolicy(actor, sql`ref->>'projectId'`)}
      ELSE ${knowledgeSourceReadPolicy(actor, sql`ref`)} END))`;
}

type ReviewView = "pending" | "history" | "detail";

function reviewState(state: SQL, view: ReviewView) {
  if (view === "pending") return sql`${state}='pending'`;
  if (view === "history") return sql`${state}<>'pending'`;

  return sql`true`;
}

async function reviewPolicy(
  tx: Db,
  userId: string,
  view: ReviewView = "pending",
  scopes?: readonly string[],
) {
  await tx.execute(sql`SET LOCAL jit=off`);
  const principal = { kind: "user", userId } as const;
  const current = await resolveKnowledgePrincipal(
    tx,
    principal,
    "knowledge:review",
  );

  if (current.kind !== "user") throw unavailableMemory();
  const actor: ReviewActor =
    scopes && !visibleReviewKinds(scopes).includes("vault")
      ? { ...current, suppressVaultSources: true }
      : current;
  const ready = await isBrainSchemaApplied(tx);
  const allowHistory = view !== "pending";
  const knowledge = ready
    ? knowledgeProposalReadPolicyCte(
        actor,
        principal,
        reviewState(sql`p.status`, view),
        sql`${allowHistory}`,
      )
    : sql`WITH`;
  const canReviewBrain = projectRole(
    actor,
    sql`bp.project_id`,
    brainReviewActions("state", "reject"),
  );
  const canAcceptBrain = sql`CASE WHEN bp.kind IN ('rule','flow','skill')
      THEN (${projectRole(actor, sql`bp.project_id`, brainReviewActions("rule", "accept"))})
      ELSE (${projectRole(actor, sql`bp.project_id`, brainReviewActions("state", "accept"))}) END`;
  const canReadBrain = projectRole(actor, sql`bp.project_id`, ["readBrain"]);
  const other = ready
    ? sql`
    UNION ALL
    SELECT 'brain', bp.id, bp.updated_at::text, left(coalesce(nullif(bp.draft->>'title',''),bp.kind),512),
      CASE WHEN bp.status<>'pending' THEN ARRAY[]::text[]
           WHEN (${canAcceptBrain}) THEN ARRAY['accept','reject'] ELSE ARRAY['reject'] END,
      bp.created_at,bp.project_id,bp.company_id,NULL::text,p.name,bp.actor->>'id',bp.status,
      bp.status='rejected' OR bp.authored_draft_id IS NOT NULL OR bp.task_id IS NOT NULL
        OR (bp.status='accepted' AND EXISTS (SELECT 1 FROM agent_memory_promotions promoted WHERE promoted.proposal_id=bp.id))
    FROM brain_proposals bp JOIN projects p ON p.id=bp.project_id AND p.archived_at IS NULL
    WHERE (${reviewState(sql`bp.status`, view)}) AND bp.kind NOT IN ('knowledge_add','knowledge_correct')
      AND CASE WHEN bp.status='pending' THEN (${canReviewBrain}) ELSE (${canReadBrain}) END
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(bp.source_restrictions,'[]'::jsonb)) ref
        WHERE NOT (${knowledgeSourceReadPolicy(actor, sql`ref`)}))
    UNION ALL
    SELECT 'knowledge', kp.id, kp.revision::text, left(kp.draft->>'title',512),
      CASE WHEN kp.status='pending' THEN ARRAY['accept','reject'] ELSE ARRAY[]::text[] END,
      kp.created_at,kp.project_id,kp.company_id,NULL::text,coalesce(p.name,'Company'),
      kp.knowledge_attribution->>'id',kp.status,kp.status='rejected' OR kp.published_record_id IS NOT NULL
    FROM knowledge_readable_proposals kp LEFT JOIN projects p ON p.id=kp.project_id
    WHERE kp.status<>'pending' OR kp.inspection_action='review'`
    : sql``;

  const vaultProjectAction = sql`CASE WHEN vp.state='pending'
    THEN (${projectRole(actor, sql`p.id`, ["readRepoFiles", "editSettings"])})
    ELSE (${projectRole(actor, sql`p.id`, ["readRepoFiles"])}) END`;
  const vaultInstallationReader = sql`EXISTS (
    SELECT 1 FROM company_grants g WHERE g.company_id=v.company_id
      AND g.principal_type='user' AND g.principal_id=${userId} AND g.action='specialists:read' AND g.revoked_at IS NULL FOR SHARE
  ) AND NOT EXISTS (
    SELECT 1 FROM unnest(vp.source_project_ids) source_id WHERE NOT (${projectContextReadPolicy(actor, sql`source_id`)})
  )`;

  return sql`${knowledge}${ready ? sql`,` : sql``} current_reviews(kind,id,version,title,allowed,created_at,project_id,company_id,agent_id,owner_label,author,domain_state,outcome_available) AS (
    SELECT 'vault', vp.id, vp.version::text, vp.changes->0->>'path',
      CASE WHEN vp.state<>'pending' THEN ARRAY[]::text[]
           WHEN (l.enabled AND l.memory_enabled) OR (reviewed.snapshot->'installationGrant'->>'memoryEnabled'='true')
           THEN ARRAY['accept','reject'] ELSE ARRAY['reject'] END,
      vp.created_at,v.project_id,v.company_id,v.agent_id,coalesce(p.name,'Company'),
      coalesce(vp.author->>'userId',vp.author->>'agentId'),vp.state,vp.state IN ('accepted','rejected')
    FROM agent_memory_proposals vp
    JOIN agent_memory_vaults v ON v.id=vp.vault_id
    LEFT JOIN projects p ON p.id=v.project_id AND p.archived_at IS NULL
    LEFT JOIN agent_project_links l ON l.project_id=v.project_id AND l.agent_id=v.agent_id
    LEFT JOIN company_specialist_bindings b ON b.company_id=v.company_id AND b.agent_id=v.agent_id AND b.detached_at IS NULL
    LEFT JOIN company_specialist_binding_revisions reviewed ON (reviewed.binding_id,reviewed.revision)=(b.id,b.revision)
    WHERE (${reviewState(sql`vp.state`, view)}) AND vp.state<>'redacted' AND (
      (p.id IS NOT NULL AND l.project_id IS NOT NULL AND (${vaultProjectAction})
        AND NOT EXISTS (SELECT 1 FROM unnest(vp.source_project_ids) source_id WHERE source_id IS DISTINCT FROM p.id))
      OR (v.company_id IS NOT NULL AND (${actor.user.role === "admin"} OR (vp.state<>'pending' AND (${vaultInstallationReader})))
        AND reviewed.snapshot->'installationGrant'->>'reach'='active_projects'))
      AND EXISTS (SELECT 1 FROM agent_memory_cutover)
      AND NOT EXISTS (SELECT 1 FROM agent_memory_operation_revisions refs
         JOIN agent_memory_redactions r ON (r.vault_id,r.note_id,r.revision_id)=(refs.vault_id,refs.note_id,refs.revision_id)
         WHERE refs.vault_id=v.id AND refs.operation_id IN (vp.operation_id,vp.applied_operation_id))
      AND ${vaultSourcePolicy(actor, ready)}${other}
  )`;
}

function reviewItem(row: ReviewRow) {
  const owner = row.project_id
    ? { kind: "project" as const, id: row.project_id, label: row.owner_label }
    : { kind: "company" as const, id: row.company_id!, label: row.owner_label };

  return {
    kind: row.kind,
    id: row.id,
    version: row.version,
    title: row.title,
    allowed: row.allowed,
    createdAt: row.at,
    owner,
    agentId: row.agent_id,
    author: row.author,
    domainState: row.domain_state,
    outcomeAvailable: row.outcome_available,
  };
}

const columns = sql`kind,id,version,title,allowed,project_id,company_id,agent_id,owner_label,author,domain_state,outcome_available,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;

export async function listProposalReviews(
  db: Db,
  userId: string,
  selection: ReviewFilter,
  credential?: PersonalKnowledgeCredential,
) {
  const { cursor, view, ...filtersForScope } = selection;
  const history = view === "history";
  const cursorNamespace = history ? historyNamespace : namespace;
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        userId,
        filtersForScope,
        ...(history ? [view] : []),
        ...(credential ? [credential.tokenId] : []),
      ]),
    )
    .digest("hex");
  const page =
    cursor === undefined
      ? null
      : validate(
          parseCursorPayload(cursorNamespace, cursor),
          history ? historyCursorSchema : cursorSchema,
        );

  if (page && page.scope !== scope)
    throw new MaisterError(
      "CONFIG",
      "Review cursor belongs to another selection",
    );

  return db.transaction(async (tx) => {
    const scopes = credential
      ? await lockPersonalKnowledgeCredential(tx, credential, "decisions:read")
      : undefined;
    const kinds = scopes ? visibleReviewKinds(scopes) : null;
    const policy = await reviewPolicy(tx, userId, view, scopes);
    const upper = page && "upper" in page ? page.upper : undefined;
    const [result] = (
      await tx.execute<{
        total: number;
        page: ReviewRow[];
      }>(sql`${policy}, scoped_reviews AS (
      SELECT * FROM current_reviews
      WHERE ${selection.kind ? sql`kind=${selection.kind}` : sql`true`}
        ${
          kinds
            ? sql`AND kind = ANY(ARRAY[${sql.join(
                kinds.map((kind) => sql`${kind}`),
                sql`,`,
              )}]::text[])`
            : sql``
        }
        ${selection.projectId ? sql`AND project_id=${selection.projectId}` : sql``}
        ${selection.companyId ? sql`AND company_id=${selection.companyId}` : sql``}
        ${selection.agentId ? sql`AND agent_id=${selection.agentId}` : sql``}
      ), selected_page AS (
        SELECT ${columns} FROM scoped_reviews
        WHERE ${page ? sql`(created_at,kind,id)<(${page.at}::timestamptz,${page.kind},${page.id})` : sql`true`}
        ${upper ? sql`AND created_at <= ${upper}::timestamptz` : sql``}
        ORDER BY created_at DESC,kind DESC,id DESC LIMIT ${selection.limit + 1}
      )
      SELECT (SELECT count(*)::int FROM scoped_reviews) AS total,
        coalesce(jsonb_agg(selected_page ORDER BY at DESC,kind DESC,id DESC),'[]') AS page
      FROM selected_page`)
    ).rows;

    if (!result)
      throw new MaisterError("CRASH", "Review selection was unavailable");
    const selected = result.page.slice(0, selection.limit);
    const last = selected.at(-1);

    log.debug(
      {
        view: view ?? "pending",
        kind: selection.kind,
        count: selected.length,
        continued: Boolean(cursor),
      },
      "proposal review page read",
    );

    return {
      items: selected.map(reviewItem),
      total: result.total,
      nextCursor:
        last && result.page.length > selection.limit
          ? signCursorPayload(cursorNamespace, {
              kind: last.kind,
              id: last.id,
              at: last.at,
              scope,
              ...(history && { upper: upper ?? selected[0]!.at }),
            })
          : null,
    };
  });
}

export async function readProposalReviewMetadata(
  tx: Db,
  userId: string,
  selection: ReviewSelector,
  credential?: PersonalKnowledgeCredential,
  operationScope = "decisions:read",
) {
  const scopes = credential
    ? await lockPersonalKnowledgeCredential(tx, credential, operationScope)
    : undefined;

  if (scopes && !visibleReviewKinds(scopes).includes(selection.kind))
    throw new MaisterError(
      "UNAUTHORIZED",
      "Token scope does not permit this proposal kind",
    );
  const policy = await reviewPolicy(tx, userId, "detail", scopes);
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
