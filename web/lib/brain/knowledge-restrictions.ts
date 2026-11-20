import "server-only";

import type {
  KnowledgeAccessRestriction,
  ExecutionContextRestriction,
  VaultRevisionRestriction,
} from "@/lib/company/types";
import type { KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeTransaction } from "./knowledge-access";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { assignmentInputReadPolicy } from "./knowledge-assignment-policy";
import { standEvidenceReadPolicy } from "./knowledge-stand-policy";
import {
  authorizeKnowledge,
  knowledgeOwner,
  resolveKnowledgePrincipal,
} from "./knowledge-access";
import {
  projectContextReadPolicy,
  projectVisibilityReadPolicy,
  agentMemoryReadPolicy,
  vaultRevisionReferenceQuery,
} from "./knowledge-context-policy";

import {
  knowledgeRestrictionsSchema,
  knowledgeAccessRestrictionSchema,
} from "@/lib/company/types";
import { isMaisterError, MaisterError } from "@/lib/errors";

export type KnowledgeRecordMetadata = Readonly<{
  id: string;
  project_id: string | null;
  company_id: string | null;
  current_revision: number;
  visibility: "owner_grants" | "restricted";
  source_restrictions: unknown;
}>;
export type KnowledgeAccessWalk = Readonly<{
  visited: readonly string[];
  remaining: number;
}>;

const retainedVaultRestrictions = z
  .array(
    z.union([
      knowledgeAccessRestrictionSchema,
      z.strictObject({
        kind: z.literal("legacy_project_private"),
        projectId: z.string().min(1).max(128),
      }),
    ]),
  )
  .max(256);
const retainedVaultSources = z.object({
  installation: z.boolean(),
  source_project_ids: z.array(z.string().min(1).max(128)).max(256),
  source_restrictions: retainedVaultRestrictions,
});

export function unavailableKnowledgeReference(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Knowledge reference is unavailable",
    { details: { reason: "knowledge_reference_unavailable" } },
  );
}

export function parseKnowledgeRestrictions(
  value: unknown,
): readonly KnowledgeAccessRestriction[] | null {
  const parsed = knowledgeRestrictionsSchema.nullable().safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Stored source restrictions do not match the native knowledge contract",
    );

  return parsed.data;
}

function enterRestriction(
  state: KnowledgeAccessWalk,
  key: string,
): KnowledgeAccessWalk {
  if (state.remaining === 0)
    throw new MaisterError(
      "PRECONDITION",
      "Knowledge access dependencies exceed the bounded resolution budget",
      { details: { reason: "knowledge_reference_budget_exceeded" } },
    );

  return { visited: [...state.visited, key], remaining: state.remaining - 1 };
}

async function authorizeOwnerRestriction(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  restriction: Extract<
    KnowledgeAccessRestriction,
    { kind: "company" | "project" }
  >,
  state: KnowledgeAccessWalk,
): Promise<KnowledgeAccessWalk> {
  const key =
    restriction.kind === "company"
      ? `company:${restriction.companyId}`
      : `project:${restriction.projectId}`;

  if (state.visited.includes(key)) return state;
  const next = enterRestriction(state, key);

  try {
    await authorizeKnowledge(tx, principal, restriction, "knowledge:read");
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED")
      throw unavailableKnowledgeReference();
    throw error;
  }

  return next;
}

async function authorizeContextRestriction(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  restriction: ExecutionContextRestriction,
  state: KnowledgeAccessWalk,
): Promise<KnowledgeAccessWalk> {
  const key = `${restriction.kind}:${JSON.stringify(restriction)}`;

  if (state.visited.includes(key)) return state;
  const next = enterRestriction(state, key);
  const identity = await resolveKnowledgePrincipal(
    tx,
    principal,
    "knowledge:read",
  );
  const policy =
    restriction.kind === "project_visibility"
      ? projectVisibilityReadPolicy(identity, sql`${restriction.projectId}`)
      : restriction.kind === "project_context"
        ? projectContextReadPolicy(identity, sql`${restriction.projectId}`)
        : agentMemoryReadPolicy(
            identity,
            sql`${restriction.projectId}`,
            sql`${restriction.agentId}`,
          );

  if ((await tx.execute(sql`SELECT 1 WHERE ${policy}`)).rows.length === 0)
    throw unavailableKnowledgeReference();

  return next;
}

async function authorizeAssignmentInputRestriction(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  restriction: Extract<
    KnowledgeAccessRestriction,
    { kind: "assignment_input" }
  >,
  state: KnowledgeAccessWalk,
): Promise<KnowledgeAccessWalk> {
  const key = `assignment_input:${JSON.stringify(restriction)}`;

  if (state.visited.includes(key)) return state;
  const next = enterRestriction(state, key);
  const identity = await resolveKnowledgePrincipal(
    tx,
    principal,
    "knowledge:read",
  );
  const policy = assignmentInputReadPolicy(
    identity,
    sql`${restriction.assignmentId}`,
    sql`${restriction.inputRevision}`,
    sql`${restriction.inputSha256}`,
  );
  const row = (
    await tx.execute(sql`
    SELECT source_restrictions FROM specialist_input_revisions
    WHERE assignment_id=${restriction.assignmentId} AND revision=${restriction.inputRevision} AND digest=${restriction.inputSha256} AND (${policy}) FOR SHARE
  `)
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();

  return authorizeSourceRestrictions(
    tx,
    principal,
    row.source_restrictions,
    next,
  );
}

async function authorizeVaultRevisionRestriction(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  restriction: VaultRevisionRestriction,
  state: KnowledgeAccessWalk,
): Promise<KnowledgeAccessWalk> {
  const key = `agent_vault_revision_v1:${JSON.stringify(restriction)}`;

  if (state.visited.includes(key)) return state;
  const next = enterRestriction(state, key);
  const identity = await resolveKnowledgePrincipal(
    tx,
    principal,
    "knowledge:read",
  );
  const { rows } = await tx.execute(
    vaultRevisionReferenceQuery(
      identity,
      sql`${JSON.stringify(restriction)}::jsonb`,
    ),
  );
  const source = retainedVaultSources.safeParse(rows[0]);

  if (!source.success) throw unavailableKnowledgeReference();
  const projectSources = source.data.source_project_ids.map((projectId) => ({
    kind: source.data.installation
      ? ("project_visibility" as const)
      : ("project_context" as const),
    projectId,
  }));

  const withProjects = await authorizeSourceRestrictions(
    tx,
    principal,
    projectSources,
    next,
  );

  return authorizeSourceRestrictions(
    tx,
    principal,
    source.data.source_restrictions.map((ref) =>
      ref.kind === "legacy_project_private"
        ? { kind: "project_context", projectId: ref.projectId }
        : ref,
    ),
    withProjects,
  );
}

export async function authorizeSourceRestrictions(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  raw: unknown,
  state: KnowledgeAccessWalk = { visited: [], remaining: 256 },
): Promise<KnowledgeAccessWalk> {
  const restrictions = parseKnowledgeRestrictions(raw);
  let current = state;

  for (const restriction of restrictions ?? []) {
    if (restriction.kind === "stand_target") {
      const key = `stand_target:${restriction.companyId}`;

      if (!current.visited.includes(key)) {
        current = enterRestriction(current, key);
        const identity = await resolveKnowledgePrincipal(
          tx,
          principal,
          "knowledge:read",
        );
        const rows = await tx.execute(
          sql`SELECT 1 WHERE ${standEvidenceReadPolicy(identity, sql`${restriction.companyId}`)}`,
        );

        if (!rows.rows.length) throw unavailableKnowledgeReference();
      }
      continue;
    }
    if (restriction.kind === "assignment_input") {
      current = await authorizeAssignmentInputRestriction(
        tx,
        principal,
        restriction,
        current,
      );
      continue;
    }
    if (restriction.kind === "agent_vault_revision_v1") {
      current = await authorizeVaultRevisionRestriction(
        tx,
        principal,
        restriction,
        current,
      );
      continue;
    }
    current =
      restriction.kind === "agent_memory" ||
      restriction.kind === "project_context" ||
      restriction.kind === "project_visibility"
        ? await authorizeContextRestriction(tx, principal, restriction, current)
        : restriction.kind === "record"
          ? (
              await authorizeKnowledgeRecordRead(
                tx,
                principal,
                restriction.recordId,
                current,
              )
            ).access
          : await authorizeOwnerRestriction(
              tx,
              principal,
              restriction,
              current,
            );
  }

  return current;
}

/** Current record policy also governs historical revisions and all derived bytes. */
export async function authorizeKnowledgeRecordRead(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  id: string,
  state: KnowledgeAccessWalk = { visited: [], remaining: 256 },
): Promise<{ record: KnowledgeRecordMetadata; access: KnowledgeAccessWalk }> {
  const row = (
    await tx.execute(
      sql`SELECT id,project_id,company_id,current_revision,visibility,source_restrictions FROM brain_items WHERE id=${id} FOR SHARE`,
    )
  ).rows[0] as unknown as KnowledgeRecordMetadata | undefined;

  if (!row) throw unavailableKnowledgeReference();
  const key = `record:${id}`;

  if (state.visited.includes(key)) return { record: row, access: state };
  let access = enterRestriction(state, key);

  access = await authorizeOwnerRestriction(
    tx,
    principal,
    knowledgeOwner(row),
    access,
  );
  if (row.visibility === "restricted") {
    const authority = await authorizeKnowledge(
      tx,
      principal,
      knowledgeOwner(row),
      "knowledge:read",
    );
    const grant = (
      await tx.execute(
        sql`SELECT id FROM brain_record_grants WHERE record_id=${id} AND principal_type=${authority.actor.kind} AND principal_id=${authority.actor.id} AND action='knowledge:read' AND revoked_at IS NULL FOR SHARE`,
      )
    ).rows[0];

    if (authority.policy.version === 2) {
      const initiatingGrant = (
        await tx.execute(
          sql`SELECT id FROM brain_record_grants WHERE record_id=${id} AND principal_type='user' AND principal_id=${authority.policy.initiator.actor.id} AND action='knowledge:read' AND revoked_at IS NULL FOR SHARE`,
        )
      ).rows[0];

      if (!initiatingGrant) throw unavailableKnowledgeReference();
    }
    const identity = await resolveKnowledgePrincipal(
      tx,
      principal,
      "knowledge:read",
    );

    if (
      identity.kind === "installation_agent" &&
      identity.installation.principal.kind === "manual"
    ) {
      const initiatingGrant =
        await tx.execute(sql`SELECT id FROM brain_record_grants WHERE record_id=${id}
        AND principal_type='user' AND principal_id=${identity.installation.principal.userId} AND action='knowledge:read' AND revoked_at IS NULL FOR SHARE`);

      if (!initiatingGrant.rows.length) throw unavailableKnowledgeReference();
    }
    if (!grant) throw unavailableKnowledgeReference();
  }

  access = await authorizeSourceRestrictions(
    tx,
    principal,
    row.source_restrictions,
    access,
  );
  const evidence = (
    await tx.execute(
      sql`SELECT witness_snapshot->'restrictions' AS restrictions FROM brain_revision_evidence WHERE record_id=${id} AND revision=${row.current_revision} LIMIT 65`,
    )
  ).rows;

  if (evidence.length > 64)
    throw new MaisterError(
      "PRECONDITION",
      "Knowledge evidence exceeds its bounded access resolution budget",
    );
  for (const entry of evidence)
    access = await authorizeSourceRestrictions(
      tx,
      principal,
      entry.restrictions ?? null,
      access,
    );

  return { record: row, access };
}

export function restrictionsForKnowledgeAccess(
  access: KnowledgeAccessWalk,
): KnowledgeAccessRestriction[] {
  return access.visited.map((key) => {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);

    if (kind === "record") return { kind, recordId: id };
    if (kind === "project") return { kind, projectId: id };
    if (kind === "company") return { kind, companyId: id };
    if (kind === "stand_target") return { kind, companyId: id };
    if (
      kind === "agent_memory" ||
      kind === "agent_vault_revision_v1" ||
      kind === "project_context" ||
      kind === "project_visibility" ||
      kind === "assignment_input"
    ) {
      const parsed = knowledgeAccessRestrictionSchema.safeParse(
        JSON.parse(id) as unknown,
      );

      if (parsed.success && parsed.data.kind === kind) return parsed.data;
      throw new MaisterError(
        "CONFIG",
        "Execution source access resolution produced an invalid context dependency",
      );
    }
    throw new MaisterError(
      "CONFIG",
      "Knowledge access resolution produced an unknown dependency kind",
    );
  });
}

/** Exact historical references retain their own restrictions in addition to the current policy head. */
export async function authorizeKnowledgeRevisionRead(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  recordId: string,
  revision: number,
  initial: KnowledgeAccessWalk = { visited: [], remaining: 256 },
): Promise<KnowledgeAccessWalk> {
  const current = await authorizeKnowledgeRecordRead(
    tx,
    principal,
    recordId,
    initial,
  );
  const row = (
    await tx.execute(
      sql`SELECT source_restrictions FROM brain_record_revisions WHERE record_id=${recordId} AND revision=${revision}`,
    )
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();
  let access = await authorizeSourceRestrictions(
    tx,
    principal,
    row.source_restrictions,
    current.access,
  );
  const proof = (
    await tx.execute(
      sql`SELECT witness_snapshot->'restrictions' AS restrictions FROM brain_revision_evidence WHERE record_id=${recordId} AND revision=${revision} LIMIT 65`,
    )
  ).rows;

  if (proof.length > 64)
    throw new MaisterError(
      "PRECONDITION",
      "Knowledge evidence exceeds its bounded access resolution budget",
    );
  for (const item of proof)
    access = await authorizeSourceRestrictions(
      tx,
      principal,
      item.restrictions ?? null,
      access,
    );

  return access;
}
