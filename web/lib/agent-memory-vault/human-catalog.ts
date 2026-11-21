import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { PersonalKnowledgeCredential } from "@/lib/tokens/personal-knowledge";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { unavailableMemory } from "./store";

import { projectRolesForActions } from "@/lib/authz";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { MaisterError } from "@/lib/errors";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";
import { postgresTextSchema } from "@/lib/text-schema";
import { lockPersonalKnowledgeCredential } from "@/lib/tokens/personal-knowledge";

const identity = postgresTextSchema.min(1).max(192);
const pageSchema = z
  .strictObject({
    projectId: identity.optional(),
    companyId: identity.optional(),
    agentId: identity.optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .pipe(z.number().max(100))
      .prefault("20"),
  })
  .refine(({ projectId, companyId }) => !projectId || !companyId);
const cursorSchema = z.strictObject({
  scope: z.string().length(64),
  last: identity,
});
const locationSchema = identity.regex(/^(project|installation):.+$/);
const namespace = "maister.human-vault-catalog.v1";
const log = pino({
  name: "human-vault-catalog",
  level: process.env.LOG_LEVEL ?? "info",
});

export type HumanVaultSelection = z.infer<typeof pageSchema>;
type CatalogRow = Readonly<{
  location_id: string;
  kind: "project" | "installation";
  owner_id: string;
  owner_label: string;
  project_slug: string | null;
  agent_id: string;
  agent_name: string;
  binding_id: string;
  vault_id: string | null;
  enabled: boolean;
  memory_enabled: boolean;
  activated: boolean;
  editable: boolean;
  settings: boolean;
  /** Unmaterialized storage is safe to identify as empty without checking hidden contents. */
  materialized: boolean;
}>;

export function parseHumanVaultSelection(
  params: URLSearchParams,
): HumanVaultSelection {
  const parsed = pageSchema.safeParse(Object.fromEntries(params));

  if (
    !parsed.success ||
    params.size !== Object.keys(Object.fromEntries(params)).length
  )
    throw new MaisterError("CONFIG", "Invalid vault catalog selector");

  return parsed.data;
}

async function locationPolicy(tx: Db, userId: string) {
  const actor = await resolveKnowledgePrincipal(
    tx,
    { kind: "user", userId },
    "knowledge:read",
  );

  if (actor.kind !== "user") throw unavailableMemory();
  const admin = actor.user.role === "admin";
  const readRoles = sql.join(
    projectRolesForActions(["readRepoFiles"]).map((role) => sql`${role}`),
    sql`,`,
  );
  const editRoles = sql.join(
    projectRolesForActions(["readRepoFiles", "editSettings"]).map(
      (role) => sql`${role}`,
    ),
    sql`,`,
  );
  const specialistRead = sql`EXISTS (
    SELECT 1 FROM company_grants g WHERE g.company_id=b.company_id AND g.principal_type='user'
      AND g.principal_id=${userId} AND g.action='specialists:read' AND g.revoked_at IS NULL FOR SHARE
  )`;

  return sql`WITH cutover AS (SELECT EXISTS (SELECT 1 FROM agent_memory_cutover) AS active),
  locations AS (
    SELECT 'project:'||l.id AS location_id, 'project' AS kind, p.id AS owner_id, p.name AS owner_label,
      p.slug AS project_slug, a.id AS agent_id, a.name AS agent_name, l.id AS binding_id, v.id AS vault_id,
      l.enabled, l.memory_enabled, cutover.active AS activated,
      (${admin} OR m.role IN (${editRoles})) IS TRUE AS editable,
      (${admin} OR m.role IN (${editRoles})) IS TRUE AS settings,
      (v.id IS NOT NULL) AS materialized
    FROM agent_project_links l JOIN projects p ON p.id=l.project_id AND p.archived_at IS NULL
    JOIN agents a ON a.id=l.agent_id
    LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=${userId}
    LEFT JOIN agent_memory_vaults v ON v.project_id=p.id AND v.agent_id=a.id
    CROSS JOIN cutover
    WHERE ${admin} OR m.role IN (${readRoles})
    UNION ALL
    SELECT 'installation:'||b.id, 'installation', b.company_id, 'Company', NULL::text,
      b.agent_id, r.snapshot->>'name', b.id, v.id, b.enabled,
      ((r.snapshot->'installationGrant'->'memoryEnabled')='true'::jsonb) IS TRUE,
      cutover.active, ${admin}, (${specialistRead}), (v.id IS NOT NULL)
    FROM company_specialist_bindings b JOIN company_specialist_binding_revisions r ON (r.binding_id,r.revision)=(b.id,b.revision)
    LEFT JOIN agent_memory_vaults v ON v.company_id=b.company_id AND v.agent_id=b.agent_id
    CROSS JOIN cutover
    WHERE b.detached_at IS NULL AND r.snapshot->'installationGrant'->>'reach'='active_projects'
      AND (${admin} OR (${specialistRead}))
  )`;
}

function locationState(row: CatalogRow) {
  if (!row.enabled) return "disabled_attachment";
  if (!row.memory_enabled) return "disabled_memory";
  if (!row.activated)
    return row.kind === "project" ? "legacy" : "awaiting_cutover";

  return row.materialized ? "ready" : "empty";
}

function describeLocation(row: CatalogRow) {
  const state = locationState(row);
  const allowedActions: Array<"view" | "edit" | "settings" | "legacy_read"> =
    [];

  if (state === "ready" || state === "empty") {
    allowedActions.push("view");
    if (row.editable) allowedActions.push("edit");
  }
  if (state === "legacy") allowedActions.push("legacy_read");
  if (row.settings) allowedActions.push("settings");

  return {
    locationId: row.location_id,
    ownerKind: row.kind,
    owner: {
      kind:
        row.kind === "project" ? ("project" as const) : ("company" as const),
      id: row.owner_id,
      label: row.owner_label,
    },
    agentId: row.agent_id,
    agentName: row.agent_name || row.agent_id,
    bindingId: row.binding_id,
    projectSlug: row.project_slug,
    state,
    allowedActions,
    href: `/knowledge/memory?${new URLSearchParams({ locationId: row.location_id })}`,
  };
}

export async function listHumanVaultLocations(
  db: Db,
  userId: string,
  selection: HumanVaultSelection,
  credential?: PersonalKnowledgeCredential,
) {
  const { cursor, ...filters } = selection;
  const scope = createHash("sha256")
    .update(JSON.stringify([userId, credential?.tokenId ?? null, filters]))
    .digest("hex");
  const continuation = cursor
    ? cursorSchema.safeParse(parseCursorPayload(namespace, cursor))
    : null;

  if (
    continuation &&
    (!continuation.success || continuation.data.scope !== scope)
  )
    throw new MaisterError(
      "CONFIG",
      "The vault continuation does not match the selection",
    );

  return db.transaction(async (tx) => {
    if (credential)
      await lockPersonalKnowledgeCredential(
        tx,
        credential,
        "agent_memory:read",
      );
    const policy = await locationPolicy(tx, userId);
    const { rows } =
      await tx.execute<CatalogRow>(sql`${policy} SELECT * FROM locations
      WHERE ${filters.projectId ? sql`kind='project' AND owner_id=${filters.projectId}` : sql`true`}
      ${filters.companyId ? sql`AND kind='installation' AND owner_id=${filters.companyId}` : sql``}
      ${filters.agentId ? sql`AND agent_id=${filters.agentId}` : sql``}
      ${continuation?.success ? sql`AND location_id > ${continuation.data.last}` : sql``}
      ORDER BY location_id LIMIT ${filters.limit + 1}`);
    const items = rows.slice(0, filters.limit).map(describeLocation);
    const last = items.at(-1);

    log.debug(
      { count: items.length, continued: Boolean(cursor) },
      "vault catalog read",
    );

    return {
      items,
      nextCursor:
        rows.length > filters.limit && last
          ? signCursorPayload(namespace, { scope, last: last.locationId })
          : null,
    };
  });
}

export async function loadHumanVaultLocation(
  tx: Db,
  userId: string,
  locationId: string,
) {
  if (!locationSchema.safeParse(locationId).success)
    throw new MaisterError("CONFIG", "Invalid vault location selector");
  const policy = await locationPolicy(tx, userId);
  const {
    rows: [row],
  } = await tx.execute<CatalogRow>(sql`${policy}
    SELECT * FROM locations WHERE location_id=${locationId}`);

  if (!row) throw unavailableMemory();
  const location = describeLocation(row);

  log.debug(
    { ownerKind: location.ownerKind, state: location.state },
    "vault location resolved",
  );

  return { location, vaultId: row.vault_id };
}

export async function getHumanVaultLocation(
  db: Db,
  userId: string,
  locationId: string,
) {
  return db.transaction(
    async (tx) =>
      (await loadHumanVaultLocation(tx, userId, locationId)).location,
  );
}

export function listHumanVaultOwners(db: Db, userId: string, agentId?: string) {
  return db.transaction(async (tx) => {
    const policy = await locationPolicy(tx, userId);
    const { rows } = await tx.execute<{
      kind: "project" | "installation";
      owner_id: string;
      owner_label: string;
    }>(sql`${policy}
      SELECT DISTINCT kind,owner_id,owner_label FROM locations
      WHERE ${agentId ? sql`agent_id=${agentId}` : sql`true`}
      ORDER BY owner_label,kind,owner_id LIMIT 513`);

    if (rows.length > 512)
      throw new MaisterError(
        "PRECONDITION",
        "The vault owner selector exceeds its bounded contract",
      );

    return rows;
  });
}
