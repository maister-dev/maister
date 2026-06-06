import "server-only";

import type {
  AuthoredCapability,
  AuthoredCapabilityBody,
  AuthoredCapabilityDetail,
  AuthoredCapabilityKind,
  AuthoredCapabilityRevision,
  CreateAuthoredCapabilityInput,
  UpdateAuthoredDraftInput,
} from "@/lib/catalog/authored-types";

import { createHash, randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

export type { AuthoredCapabilityKind };

export type CanonicalHashInput = {
  kind: AuthoredCapabilityKind;
  body?: AuthoredCapabilityBody | null;
  manifest?: AuthoredCapabilityBody | null;
  schemaVersion?: number;
};

type CatalogDb = {
  execute(query: SQL): Promise<QueryResult>;
};

type TransactionalCatalogDb = CatalogDb & {
  transaction<T>(fn: (tx: CatalogDb) => Promise<T>): Promise<T>;
};

type QueryResult = {
  rows?: unknown[];
};

type ProjectRow = { id: string };

type CapabilityRow = {
  id: string;
  project_id: string;
  kind: AuthoredCapabilityKind;
  slug: string;
  title: string;
  lifecycle: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  draft_version: number;
  current_draft_revision_id: string | null;
  current_published_revision_id: string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type RevisionRow = {
  id: string;
  capability_id: string;
  project_id: string;
  kind: AuthoredCapabilityKind;
  revision_number: number;
  lifecycle: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  draft_version: number;
  title: string;
  body: AuthoredCapabilityBody;
  manifest: AuthoredCapabilityBody | null;
  schema_version: number;
  content_hash: string;
  created_at: Date | string;
  published_at: Date | string | null;
  archived_at: Date | string | null;
};

type UpdatedCapabilityRow = { id: string };

const log = pino({
  name: "authored-catalog",
  level: process.env.LOG_LEVEL ?? "info",
});

export function canonicalAuthoredContentHash(
  input: CanonicalHashInput,
): string {
  const envelope = {
    kind: input.kind,
    body: input.body ?? {},
    manifest: input.manifest ?? null,
    schemaVersion: input.schemaVersion ?? 1,
  };

  return createHash("sha256").update(stableStringify(envelope)).digest("hex");
}

export function assertDraftVersion(input: {
  expectedDraftVersion: number;
  actualDraftVersion: number;
}): void {
  if (input.expectedDraftVersion !== input.actualDraftVersion) {
    throw new MaisterError(
      "CONFLICT",
      `stale authored capability draft: expected draft_version=${input.expectedDraftVersion}, actual=${input.actualDraftVersion}`,
    );
  }
}

export async function listAuthoredCapabilities(args: {
  projectSlug: string;
  db?: CatalogDb;
}): Promise<AuthoredCapability[]> {
  const db = args.db ?? (getDb() as unknown as CatalogDb);
  const projectId = await resolveProjectId(db, args.projectSlug);
  const result = await db.execute(sql`
    SELECT *
    FROM authored_capabilities
    WHERE project_id = ${projectId}
    ORDER BY kind ASC, slug ASC
  `);

  return rowsOf<CapabilityRow>(result).map(toCapability);
}

export async function getAuthoredCapability(args: {
  projectSlug: string;
  capId: string;
  db?: CatalogDb;
}): Promise<AuthoredCapabilityDetail> {
  const db = args.db ?? (getDb() as unknown as CatalogDb);
  const projectId = await resolveProjectId(db, args.projectSlug);
  const cap = await loadCapability(db, projectId, args.capId);
  const revisions = await loadCapabilityRevisions(db, args.capId);
  const draft =
    revisions.find((revision) => revision.lifecycle === "DRAFT") ?? null;
  const published =
    revisions.find(
      (revision) => revision.id === cap.current_published_revision_id,
    ) ?? null;

  return {
    capability: toCapability(cap),
    draft,
    published,
    revisions,
  };
}

export async function createAuthoredCapability(args: {
  projectSlug: string;
  input: CreateAuthoredCapabilityInput;
  db?: TransactionalCatalogDb;
}): Promise<{
  capability: AuthoredCapability;
  draft: AuthoredCapabilityRevision;
}> {
  const db = args.db ?? (getDb() as unknown as TransactionalCatalogDb);

  return db.transaction(async (tx) => {
    const projectId = await resolveProjectId(tx, args.projectSlug);
    const capId = randomUUID();
    const revisionId = randomUUID();
    const draftVersion = 1;
    const body = args.input.body ?? {};
    const manifest = args.input.manifest ?? null;
    const schemaVersion = args.input.schemaVersion ?? 1;
    const now = new Date();
    const contentHash = canonicalAuthoredContentHash({
      kind: args.input.kind,
      body,
      manifest,
      schemaVersion,
    });

    await tx.execute(sql`
      INSERT INTO authored_capabilities (
        id,
        project_id,
        kind,
        slug,
        title,
        lifecycle,
        draft_version,
        current_draft_revision_id,
        created_at,
        updated_at
      )
      VALUES (
        ${capId},
        ${projectId},
        ${args.input.kind},
        ${args.input.slug},
        ${args.input.title},
        'DRAFT',
        ${draftVersion},
        ${revisionId},
        now(),
        now()
      )
    `);
    await tx.execute(sql`
      INSERT INTO authored_capability_revisions (
        id,
        capability_id,
        project_id,
        kind,
        revision_number,
        lifecycle,
        draft_version,
        title,
        body,
        manifest,
        schema_version,
        content_hash,
        created_at
      )
      VALUES (
        ${revisionId},
        ${capId},
        ${projectId},
        ${args.input.kind},
        1,
        'DRAFT',
        ${draftVersion},
        ${args.input.title},
        ${body},
        ${manifest},
        ${schemaVersion},
        ${contentHash},
        now()
      )
    `);

    log.info(
      { projectId, capId, kind: args.input.kind, revisionId },
      "authored capability draft created",
    );

    return {
      capability: {
        id: capId,
        projectId,
        kind: args.input.kind,
        slug: args.input.slug,
        title: args.input.title,
        lifecycle: "DRAFT",
        draftVersion,
        currentDraftRevisionId: revisionId,
        currentPublishedRevisionId: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      draft: {
        id: revisionId,
        capabilityId: capId,
        projectId,
        kind: args.input.kind,
        revisionNumber: 1,
        lifecycle: "DRAFT",
        draftVersion,
        title: args.input.title,
        body,
        manifest,
        schemaVersion,
        contentHash,
        publishedAt: null,
        archivedAt: null,
        createdAt: now,
      },
    };
  });
}

export async function updateAuthoredDraft(args: {
  projectSlug: string;
  capId: string;
  input: UpdateAuthoredDraftInput;
  db?: TransactionalCatalogDb;
}): Promise<AuthoredCapabilityRevision> {
  const db = args.db ?? (getDb() as unknown as TransactionalCatalogDb);

  return db.transaction(async (tx) => {
    const projectId = await resolveProjectId(tx, args.projectSlug);
    const cap = await loadCapability(tx, projectId, args.capId);

    if (cap.lifecycle === "ARCHIVED") {
      throw new MaisterError(
        "CONFLICT",
        "archived authored capability is immutable",
      );
    }
    assertDraftVersion({
      expectedDraftVersion: args.input.expectedDraftVersion,
      actualDraftVersion: cap.draft_version,
    });

    const existingDraft = await loadDraftRevisionOrNull(tx, args.capId);
    const existing =
      existingDraft ??
      (await loadPublishedRevision(
        tx,
        args.capId,
        cap.current_published_revision_id,
      ));
    const nextDraftVersion = cap.draft_version + 1;
    const revisionId = randomUUID();
    const now = new Date();
    const title = args.input.title ?? existing.title;
    const body = args.input.body ?? existing.body;
    const manifest =
      "manifest" in args.input
        ? (args.input.manifest ?? null)
        : existing.manifest;
    const schemaVersion = args.input.schemaVersion ?? existing.schema_version;
    const contentHash = canonicalAuthoredContentHash({
      kind: cap.kind,
      body,
      manifest,
      schemaVersion,
    });

    const updatedCapability = await tx.execute(sql`
      UPDATE authored_capabilities
      SET
        title = ${title},
        lifecycle = 'DRAFT',
        draft_version = ${nextDraftVersion},
        current_draft_revision_id = ${revisionId},
        updated_at = now()
      WHERE id = ${args.capId}
        AND project_id = ${projectId}
        AND lifecycle <> 'ARCHIVED'
        AND draft_version = ${args.input.expectedDraftVersion}
      RETURNING id
    `);

    if (rowsOf<UpdatedCapabilityRow>(updatedCapability).length === 0) {
      log.warn(
        {
          projectId,
          capId: args.capId,
          expectedDraftVersion: args.input.expectedDraftVersion,
        },
        "stale authored capability draft update refused",
      );

      throw new MaisterError(
        "CONFLICT",
        `stale authored capability draft: expected draft_version=${args.input.expectedDraftVersion}`,
      );
    }

    if (existingDraft !== null) {
      await tx.execute(sql`
        UPDATE authored_capability_revisions
        SET lifecycle = 'ARCHIVED', archived_at = now()
        WHERE id = ${existingDraft.id}
          AND capability_id = ${args.capId}
          AND lifecycle = 'DRAFT'
      `);
    }
    await tx.execute(sql`
      INSERT INTO authored_capability_revisions (
        id,
        capability_id,
        project_id,
        kind,
        revision_number,
        lifecycle,
        draft_version,
        title,
        body,
        manifest,
        schema_version,
        content_hash,
        created_at
      )
      VALUES (
        ${revisionId},
        ${args.capId},
        ${projectId},
        ${cap.kind},
        ${existing.revision_number + 1},
        'DRAFT',
        ${nextDraftVersion},
        ${title},
        ${body},
        ${manifest},
        ${schemaVersion},
        ${contentHash},
        now()
      )
    `);

    return {
      id: revisionId,
      capabilityId: args.capId,
      projectId,
      kind: cap.kind,
      revisionNumber: existing.revision_number + 1,
      lifecycle: "DRAFT",
      draftVersion: nextDraftVersion,
      title,
      body,
      manifest,
      schemaVersion,
      contentHash,
      publishedAt: null,
      archivedAt: null,
      createdAt: now,
    };
  });
}

export async function publishAuthoredCapabilityLocal(args: {
  projectSlug: string;
  capId: string;
  db?: TransactionalCatalogDb;
}): Promise<{
  revision: AuthoredCapabilityRevision;
  materializedRecordId: string | null;
}> {
  const db = args.db ?? (getDb() as unknown as TransactionalCatalogDb);

  return db.transaction(async (tx) => {
    const projectId = await resolveProjectId(tx, args.projectSlug);
    const cap = await loadCapability(tx, projectId, args.capId);

    if (cap.lifecycle === "ARCHIVED") {
      throw new MaisterError(
        "CONFLICT",
        "archived authored capability cannot publish",
      );
    }

    const revision = await loadDraftRevision(tx, args.capId);
    const publishedAt = new Date();
    let materializedRecordId: string | null = null;

    await assertNoNonAuthoredProjectCollision(
      tx,
      projectId,
      cap.kind,
      cap.slug,
    );
    await tx.execute(sql`
      UPDATE authored_capability_revisions
      SET lifecycle = 'PUBLISHED', published_at = now()
      WHERE id = ${revision.id}
    `);
    await tx.execute(sql`
      UPDATE authored_capabilities
      SET
        lifecycle = 'PUBLISHED',
        current_published_revision_id = ${revision.id},
        current_draft_revision_id = NULL,
        updated_at = now()
      WHERE id = ${args.capId}
        AND project_id = ${projectId}
    `);

    if (cap.kind === "rule" || cap.kind === "skill") {
      materializedRecordId = await upsertAuthoredCapabilityRecord(
        tx,
        projectId,
        cap,
        revision,
      );
    }

    return {
      revision: {
        ...toRevision(revision),
        lifecycle: "PUBLISHED",
        publishedAt,
      },
      materializedRecordId,
    };
  });
}

export async function archiveAuthoredCapability(args: {
  projectSlug: string;
  capId: string;
  db?: TransactionalCatalogDb;
}): Promise<AuthoredCapability> {
  const db = args.db ?? (getDb() as unknown as TransactionalCatalogDb);

  return db.transaction(async (tx) => {
    const projectId = await resolveProjectId(tx, args.projectSlug);
    const cap = await loadCapability(tx, projectId, args.capId);

    if (cap.lifecycle === "ARCHIVED") {
      return toCapability(cap);
    }

    const archivedAt = new Date();

    await tx.execute(sql`
      UPDATE authored_capabilities
      SET lifecycle = 'ARCHIVED', archived_at = now(), updated_at = now()
      WHERE id = ${args.capId}
        AND project_id = ${projectId}
    `);
    await tx.execute(sql`
      UPDATE authored_capability_revisions
      SET lifecycle = 'ARCHIVED', archived_at = now()
      WHERE capability_id = ${args.capId}
        AND lifecycle <> 'ARCHIVED'
    `);
    await tx.execute(sql`
      UPDATE capability_records
      SET selectable = false, disabled_at = now(), updated_at = now()
      WHERE project_id = ${projectId}
        AND source = 'project'
        AND kind = ${cap.kind}
        AND capability_ref_id = ${cap.slug}
        AND material->>'origin' = 'authored'
    `);

    return {
      ...toCapability(cap),
      lifecycle: "ARCHIVED",
      archivedAt,
      updatedAt: archivedAt,
    };
  });
}

async function upsertAuthoredCapabilityRecord(
  db: CatalogDb,
  projectId: string,
  cap: CapabilityRow,
  revision: RevisionRow,
): Promise<string> {
  const recordId = randomUUID();
  const agentsJson = JSON.stringify(["claude", "codex"]);
  const material = {
    origin: "authored",
    authoredCapabilityId: cap.id,
    authoredRevisionId: revision.id,
    body: revision.body,
    manifest: revision.manifest,
    schemaVersion: revision.schema_version,
  };
  const materialJson = JSON.stringify(material);
  const result = await db.execute(sql`
    INSERT INTO capability_records (
      id,
      project_id,
      capability_ref_id,
      kind,
      label,
      source,
      version,
      revision,
      agents,
      enforceability,
      selected_by_default,
      selectable,
      material,
      disabled_at,
      updated_at
    )
    VALUES (
      ${recordId},
      ${projectId},
      ${cap.slug},
      ${cap.kind},
      ${cap.title},
      'project',
      'local',
      ${revision.content_hash},
      ${agentsJson}::jsonb,
      'instructed',
      true,
      true,
      ${materialJson}::jsonb,
      NULL,
      now()
    )
    ON CONFLICT (project_id, source, kind, capability_ref_id)
    DO UPDATE SET
      label = EXCLUDED.label,
      version = EXCLUDED.version,
      revision = EXCLUDED.revision,
      agents = EXCLUDED.agents,
      enforceability = EXCLUDED.enforceability,
      selected_by_default = EXCLUDED.selected_by_default,
      selectable = true,
      material = EXCLUDED.material,
      disabled_at = NULL,
      updated_at = now()
    RETURNING id
  `);

  return rowsOf<{ id: string }>(result)[0]?.id ?? recordId;
}

async function assertNoNonAuthoredProjectCollision(
  db: CatalogDb,
  projectId: string,
  kind: AuthoredCapabilityKind,
  slug: string,
): Promise<void> {
  const result = await db.execute(sql`
    SELECT id
    FROM capability_records
    WHERE project_id = ${projectId}
      AND source = 'project'
      AND kind = ${kind}
      AND capability_ref_id = ${slug}
      AND coalesce(material->>'origin', '') <> 'authored'
    LIMIT 1
  `);

  if (rowsOf<{ id: string }>(result).length > 0) {
    throw new MaisterError(
      "CONFLICT",
      `authored capability ${kind}/${slug} collides with a non-authored project capability`,
    );
  }
}

async function loadCapability(
  db: CatalogDb,
  projectId: string,
  capId: string,
): Promise<CapabilityRow> {
  const result = await db.execute(sql`
    SELECT *
    FROM authored_capabilities
    WHERE id = ${capId}
      AND project_id = ${projectId}
    LIMIT 1
  `);
  const row = rowsOf<CapabilityRow>(result)[0];

  if (!row) {
    throw new MaisterError("CONFIG", `authored capability not found: ${capId}`);
  }

  return row;
}

async function loadDraftRevision(
  db: CatalogDb,
  capId: string,
): Promise<RevisionRow> {
  const row = await loadDraftRevisionOrNull(db, capId);

  if (!row) {
    throw new MaisterError(
      "CONFLICT",
      `authored capability has no draft: ${capId}`,
    );
  }

  return row;
}

async function loadDraftRevisionOrNull(
  db: CatalogDb,
  capId: string,
): Promise<RevisionRow | null> {
  const result = await db.execute(sql`
    SELECT *
    FROM authored_capability_revisions
    WHERE capability_id = ${capId}
      AND lifecycle = 'DRAFT'
    ORDER BY revision_number DESC
    LIMIT 1
  `);

  return rowsOf<RevisionRow>(result)[0] ?? null;
}

async function loadPublishedRevision(
  db: CatalogDb,
  capId: string,
  revisionId: string | null,
): Promise<RevisionRow> {
  if (revisionId === null) {
    throw new MaisterError(
      "CONFLICT",
      `authored capability has no editable draft or published base: ${capId}`,
    );
  }

  const result = await db.execute(sql`
    SELECT *
    FROM authored_capability_revisions
    WHERE capability_id = ${capId}
      AND id = ${revisionId}
      AND lifecycle = 'PUBLISHED'
    LIMIT 1
  `);
  const row = rowsOf<RevisionRow>(result)[0];

  if (!row) {
    throw new MaisterError(
      "CONFLICT",
      `authored capability published base not found: ${capId}`,
    );
  }

  return row;
}

async function loadCapabilityRevisions(
  db: CatalogDb,
  capId: string,
): Promise<AuthoredCapabilityRevision[]> {
  const result = await db.execute(sql`
    SELECT *
    FROM authored_capability_revisions
    WHERE capability_id = ${capId}
    ORDER BY revision_number DESC
  `);

  return rowsOf<RevisionRow>(result).map(toRevision);
}

async function resolveProjectId(db: CatalogDb, slug: string): Promise<string> {
  const result = await db.execute(sql`
    SELECT id
    FROM projects
    WHERE slug = ${slug}
    LIMIT 1
  `);
  const row = rowsOf<ProjectRow>(result)[0];

  if (!row) {
    throw new MaisterError("CONFIG", `project not found: ${slug}`);
  }

  return row.id;
}

function toCapability(row: CapabilityRow): AuthoredCapability {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    lifecycle: row.lifecycle,
    draftVersion: row.draft_version,
    currentDraftRevisionId: row.current_draft_revision_id,
    currentPublishedRevisionId: row.current_published_revision_id,
    archivedAt: nullableDate(row.archived_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function toRevision(row: RevisionRow): AuthoredCapabilityRevision {
  return {
    id: row.id,
    capabilityId: row.capability_id,
    projectId: row.project_id,
    kind: row.kind,
    revisionNumber: row.revision_number,
    lifecycle: row.lifecycle,
    draftVersion: row.draft_version,
    title: row.title,
    body: row.body,
    manifest: row.manifest,
    schemaVersion: row.schema_version,
    contentHash: row.content_hash,
    publishedAt: nullableDate(row.published_at),
    archivedAt: nullableDate(row.archived_at),
    createdAt: dateValue(row.created_at),
  };
}

function rowsOf<T>(result: QueryResult): T[] {
  return (result.rows ?? []) as T[];
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : dateValue(value);
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);

  return `{${entries.join(",")}}`;
}
