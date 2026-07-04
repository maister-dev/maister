import "server-only";

import type { BuiltInSourceKind } from "./chunkers/types";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import picomatch from "picomatch";
import pino from "pino";
import { z } from "zod";

import { defaultChunkerIdForKind, detectSourceKind } from "./chunkers/registry";
import { sha256 } from "./codec";

import { workbenchMaxFileBytes } from "@/lib/instance-config";
import { MaisterError } from "@/lib/errors";
import { listTree, readBlob, repoRelPathSchema } from "@/lib/worktree";

const log = pino({
  name: "brain:sources",
  level: process.env.LOG_LEVEL ?? "info",
});

export const BRAIN_SOURCE_CHUNKER_VERSION = "1";
export const BRAIN_SOURCE_MAX_GLOB_MATCHES = 200;
export const BRAIN_SOURCE_MAX_TOTAL_BYTES = 2_000_000;

const BRAIN_SOURCE_KINDS = [
  "repo_file",
  "markdown",
  "html",
  "openapi",
  "asyncapi",
  "sql",
  "flow_yaml",
  "package_yaml",
  "agent_md",
  "code",
  "text",
] as const satisfies readonly BuiltInSourceKind[];

const sourceInputSchema = z
  .object({
    kind: z.enum(BRAIN_SOURCE_KINDS).optional(),
    path: z.string().min(1).max(512).optional(),
    chunkerId: z.string().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type SourcesDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface BrainSourceInput {
  kind?: BuiltInSourceKind;
  path?: string;
  chunkerId?: string;
  enabled?: boolean;
}

export interface CreateBrainSourceArgs {
  projectId: string;
  repoPath: string;
  mainBranch: string;
  input: BrainSourceInput;
}

export interface UpdateBrainSourceArgs extends CreateBrainSourceArgs {
  sourceId: string;
}

export interface BrainSourceDto {
  id: string;
  kind: BuiltInSourceKind;
  path: string;
  chunkerId: string;
  chunkerVersion: string;
  enabled: boolean;
  sourceHash: string | null;
  lastIndexedAt: Date | string | null;
  lastError: Record<string, unknown> | null;
  chunkCount: number;
}

export interface SourceContent {
  path: string;
  content: string;
  sourceHash: string;
}

export interface SourceContentSet {
  files: SourceContent[];
  sourceHash: string;
}

const DEFAULT_SOURCE_INPUTS: Array<{
  path: string;
  kind: BuiltInSourceKind;
  chunkerId: string;
}> = [
  { path: "docs/**/*.md", kind: "markdown", chunkerId: "markdown" },
  { path: "docs/decisions.md", kind: "markdown", chunkerId: "markdown" },
  {
    path: ".ai-factory/ROADMAP.md",
    kind: "markdown",
    chunkerId: "markdown",
  },
  { path: "docs/api/*.yaml", kind: "openapi", chunkerId: "openapi" },
  { path: "maister.yaml", kind: "flow_yaml", chunkerId: "flow_yaml" },
];

function toBrainSourceDto(row: Record<string, unknown>): BrainSourceDto {
  return {
    id: String(row.id),
    kind: row.kind as BuiltInSourceKind,
    path: String(row.path),
    chunkerId: String(row.chunker_id),
    chunkerVersion: String(row.chunker_version),
    enabled: Boolean(row.enabled),
    sourceHash: (row.source_hash as string | null) ?? null,
    lastIndexedAt: (row.last_indexed_at as Date | string | null) ?? null,
    lastError: (row.last_error as Record<string, unknown> | null) ?? null,
    chunkCount: Number(row.chunk_count ?? 0),
  };
}

function parseSourceInput(
  input: BrainSourceInput,
): z.infer<typeof sourceInputSchema> {
  const parsed = sourceInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      parsed.error.issues[0]?.message ?? "invalid Brain source input",
    );
  }

  return parsed.data;
}

function validateSourcePath(path: string): string {
  const parsed = repoRelPathSchema.safeParse(path);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `invalid Brain source path "${path}": ${parsed.error.issues[0]?.message ?? "repo-relative path required"}`,
    );
  }

  return parsed.data;
}

export function isBrainSourceGlob(path: string): boolean {
  return /[*?[\]{}]/.test(path);
}

async function listTrackedFilePaths(args: {
  repoPath: string;
  ref: string;
  dir?: string;
}): Promise<string[]> {
  const paths: string[] = [];

  async function visit(dir: string): Promise<void> {
    const tree = await listTree({ repo: args.repoPath, ref: args.ref, dir });

    if (!tree) return;

    for (const entry of tree.entries) {
      const nextPath = dir === "" ? entry.name : `${dir}/${entry.name}`;

      if (entry.type === "dir") {
        await visit(nextPath);
      } else {
        paths.push(nextPath);
      }
    }
  }

  await visit(args.dir ?? "");

  return paths.sort();
}

function globSearchRoot(path: string): string {
  const firstGlobIndex = path.search(/[*?[\]{}]/);

  if (firstGlobIndex === -1)
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  const fixedPrefix = path.slice(0, firstGlobIndex);
  const lastSlashIndex = fixedPrefix.lastIndexOf("/");

  if (lastSlashIndex === -1) return "";

  return fixedPrefix.slice(0, lastSlashIndex);
}

function hashSourceContentSet(files: readonly SourceContent[]): string {
  return sha256(
    files.map((file) => `${file.path}\0${file.sourceHash}`).join("\0"),
  );
}

export async function readBrainSourceContent(args: {
  repoPath: string;
  ref: string;
  path: string;
  maxBytes?: number;
}): Promise<SourceContent> {
  const path = validateSourcePath(args.path);

  if (isBrainSourceGlob(path)) {
    throw new MaisterError(
      "CONFIG",
      `Brain source "${path}" is a glob and must be expanded before content read`,
    );
  }

  const blob = await readBlob({
    repo: args.repoPath,
    ref: args.ref,
    path,
    maxBytes: args.maxBytes ?? workbenchMaxFileBytes(),
  });

  if (blob.kind === "text") {
    return {
      path,
      content: blob.content,
      sourceHash: sha256(blob.content),
    };
  }

  if (blob.kind === "too-large") {
    throw new MaisterError(
      "PRECONDITION",
      `Brain source "${path}" is too large to index (${blob.size} bytes)`,
    );
  }

  if (blob.kind === "binary") {
    throw new MaisterError(
      "PRECONDITION",
      `Brain source "${path}" is binary and cannot be indexed`,
    );
  }

  throw new MaisterError(
    "PRECONDITION",
    `Brain source "${path}" is not a tracked text file at ${args.ref}`,
  );
}

export async function readBrainSourceContents(args: {
  repoPath: string;
  ref: string;
  path: string;
  maxBytes?: number;
  excludePaths?: readonly string[];
  maxMatches?: number;
  maxTotalBytes?: number;
}): Promise<SourceContentSet> {
  const path = validateSourcePath(args.path);

  if (!isBrainSourceGlob(path)) {
    const content = await readBrainSourceContent({ ...args, path });

    return { files: [content], sourceHash: content.sourceHash };
  }

  const isMatch = picomatch(path, { dot: true });
  const excludedPaths = new Set(
    (args.excludePaths ?? []).map((excludedPath) =>
      validateSourcePath(excludedPath),
    ),
  );
  const trackedMatches = (
    await listTrackedFilePaths({
      repoPath: args.repoPath,
      ref: args.ref,
      dir: globSearchRoot(path),
    })
  ).filter((filePath) => isMatch(filePath));
  const matchedPaths = trackedMatches.filter(
    (filePath) => !excludedPaths.has(filePath),
  );
  const maxMatches = args.maxMatches ?? BRAIN_SOURCE_MAX_GLOB_MATCHES;

  if (trackedMatches.length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `Brain source glob "${path}" matched no tracked files at ${args.ref}`,
    );
  }

  if (matchedPaths.length === 0) {
    return { files: [], sourceHash: hashSourceContentSet([]) };
  }

  if (matchedPaths.length > maxMatches) {
    log.warn(
      {
        path,
        ref: args.ref,
        matchCount: matchedPaths.length,
        maxMatches,
        reason: "glob_match_limit",
      },
      "brain source glob rejected",
    );

    throw new MaisterError(
      "PRECONDITION",
      `Brain source glob "${path}" matched ${matchedPaths.length} tracked files at ${args.ref}; limit is ${maxMatches}`,
    );
  }

  const files: SourceContent[] = [];
  const maxTotalBytes = args.maxTotalBytes ?? BRAIN_SOURCE_MAX_TOTAL_BYTES;
  let totalBytes = 0;

  for (const filePath of matchedPaths) {
    const file = await readBrainSourceContent({
      ...args,
      path: filePath,
    });

    totalBytes += Buffer.byteLength(file.content, "utf8");

    if (totalBytes > maxTotalBytes) {
      log.warn(
        {
          path,
          ref: args.ref,
          totalBytes,
          maxTotalBytes,
          reason: "glob_total_bytes_limit",
        },
        "brain source glob rejected",
      );

      throw new MaisterError(
        "PRECONDITION",
        `Brain source glob "${path}" exceeds the aggregate indexed byte limit (${totalBytes}/${maxTotalBytes})`,
      );
    }

    files.push(file);
  }

  return {
    files,
    sourceHash: hashSourceContentSet(files),
  };
}

async function assertSourceReadable(args: {
  repoPath: string;
  ref: string;
  path: string;
}): Promise<void> {
  await readBrainSourceContents(args);
}

export async function listBrainSources(
  db: SourcesDb,
  projectId: string,
): Promise<BrainSourceDto[]> {
  const rows = await db.execute(sql`
    SELECT s.id, s.kind, s.path, s.chunker_id, s.chunker_version, s.enabled,
           s.source_hash, s.last_indexed_at, s.last_error,
           count(c.id)::int AS chunk_count
    FROM brain_sources s
    LEFT JOIN brain_chunks c ON c.source_id = s.id
    WHERE s.project_id = ${projectId}
    GROUP BY s.id
    ORDER BY s.created_at ASC, s.path ASC
  `);

  return rows.rows.map(toBrainSourceDto);
}

export async function createBrainSource(
  db: SourcesDb,
  args: CreateBrainSourceArgs,
): Promise<BrainSourceDto> {
  const input = parseSourceInput(args.input);

  if (!input.path) {
    throw new MaisterError("CONFIG", "Brain source path is required");
  }

  const path = validateSourcePath(input.path);
  const kind = input.kind ?? detectSourceKind(path);
  const chunkerId = input.chunkerId ?? defaultChunkerIdForKind(kind);

  await assertSourceReadable({
    repoPath: args.repoPath,
    ref: args.mainBranch,
    path,
  });

  const inserted = await db.execute(sql`
    INSERT INTO brain_sources
      (id, project_id, kind, path, chunker_id, chunker_version, enabled)
    VALUES
      (${randomUUID()}, ${args.projectId}, ${kind}, ${path}, ${chunkerId},
       ${BRAIN_SOURCE_CHUNKER_VERSION}, ${input.enabled ?? true})
    ON CONFLICT (project_id, kind, path)
    DO UPDATE SET
      chunker_id = EXCLUDED.chunker_id,
      chunker_version = EXCLUDED.chunker_version,
      enabled = EXCLUDED.enabled,
      updated_at = now()
    RETURNING id
  `);

  const sourceId = String(inserted.rows[0]?.id);

  log.info(
    { projectId: args.projectId, sourceId, kind, path, reason: "create" },
    "brain source saved",
  );

  return getBrainSource(db, args.projectId, sourceId);
}

export async function updateBrainSource(
  db: SourcesDb,
  args: UpdateBrainSourceArgs,
): Promise<BrainSourceDto> {
  const current = await getBrainSource(db, args.projectId, args.sourceId);
  const input = parseSourceInput(args.input);
  const path = validateSourcePath(input.path ?? current.path);
  const kind = input.kind ?? current.kind;
  const chunkerId = input.chunkerId ?? current.chunkerId;

  await assertSourceReadable({
    repoPath: args.repoPath,
    ref: args.mainBranch,
    path,
  });

  await db.execute(sql`
    UPDATE brain_sources
    SET kind = ${kind},
        path = ${path},
        chunker_id = ${chunkerId},
        chunker_version = ${BRAIN_SOURCE_CHUNKER_VERSION},
        enabled = ${input.enabled ?? current.enabled},
        updated_at = now()
    WHERE id = ${args.sourceId} AND project_id = ${args.projectId}
  `);

  log.info(
    {
      projectId: args.projectId,
      sourceId: args.sourceId,
      kind,
      path,
      reason: "update",
    },
    "brain source updated",
  );

  return getBrainSource(db, args.projectId, args.sourceId);
}

export async function deleteBrainSource(
  db: SourcesDb,
  args: { projectId: string; sourceId: string },
): Promise<void> {
  const deleted = await db.execute(sql`
    DELETE FROM brain_sources
    WHERE id = ${args.sourceId} AND project_id = ${args.projectId}
    RETURNING id, kind, path
  `);

  if (deleted.rows.length === 0) {
    throw new MaisterError("PRECONDITION", "Brain source not found");
  }

  const row = deleted.rows[0];

  log.info(
    {
      projectId: args.projectId,
      sourceId: args.sourceId,
      kind: row.kind,
      path: row.path,
      reason: "delete",
    },
    "brain source deleted",
  );
}

export async function enqueueBrainSourceReindex(
  db: SourcesDb,
  args: {
    projectId: string;
    sourceId: string;
    reason?: "manual" | "event" | "chunker_upgrade";
  },
): Promise<string> {
  await getBrainSource(db, args.projectId, args.sourceId);

  const inserted = await db.execute(sql`
    INSERT INTO brain_index_jobs (id, project_id, source_id, reason, status)
    VALUES (
      ${randomUUID()},
      ${args.projectId},
      ${args.sourceId},
      ${args.reason ?? "manual"},
      'queued'
    )
    RETURNING id
  `);
  const jobId = String(inserted.rows[0]?.id);

  log.info(
    {
      projectId: args.projectId,
      sourceId: args.sourceId,
      jobId,
      reason: args.reason ?? "manual",
    },
    "brain source reindex enqueued",
  );

  return jobId;
}

export async function enqueueAllBrainSourcesReindex(
  db: SourcesDb,
  args: {
    projectId: string;
    reason?: "manual" | "event" | "chunker_upgrade";
  },
): Promise<string[]> {
  const sources = await listBrainSources(db, args.projectId);
  const jobIds: string[] = [];

  for (const source of sources) {
    if (!source.enabled) continue;

    jobIds.push(
      await enqueueBrainSourceReindex(db, {
        projectId: args.projectId,
        sourceId: source.id,
        reason: args.reason ?? "manual",
      }),
    );
  }

  return jobIds;
}

export async function seedDefaultBrainSources(
  db: SourcesDb,
  projectId: string,
): Promise<BrainSourceDto[]> {
  const created: BrainSourceDto[] = [];

  for (const source of DEFAULT_SOURCE_INPUTS) {
    const inserted = await db.execute(sql`
      INSERT INTO brain_sources
        (id, project_id, kind, path, chunker_id, chunker_version, enabled)
      VALUES
        (${randomUUID()}, ${projectId}, ${source.kind}, ${source.path},
         ${source.chunkerId}, ${BRAIN_SOURCE_CHUNKER_VERSION}, true)
      ON CONFLICT (project_id, kind, path) DO NOTHING
      RETURNING id
    `);

    if (inserted.rows.length === 0) continue;

    created.push(
      await getBrainSource(db, projectId, String(inserted.rows[0]?.id)),
    );
  }

  return created;
}

export async function seedDefaultBrainSourcesForFirstSetup(
  db: SourcesDb,
  projectId: string,
): Promise<BrainSourceDto[]> {
  const existing = await db.execute(sql`
    SELECT id
    FROM brain_sources
    WHERE project_id = ${projectId}
    LIMIT 1
  `);

  if (existing.rows.length > 0) {
    log.debug(
      { projectId, reason: "existing_sources_present" },
      "brain default source seed skipped",
    );

    return [];
  }

  return seedDefaultBrainSources(db, projectId);
}

async function getBrainSource(
  db: SourcesDb,
  projectId: string,
  sourceId: string,
): Promise<BrainSourceDto> {
  const rows = await db.execute(sql`
    SELECT s.id, s.kind, s.path, s.chunker_id, s.chunker_version, s.enabled,
           s.source_hash, s.last_indexed_at, s.last_error,
           count(c.id)::int AS chunk_count
    FROM brain_sources s
    LEFT JOIN brain_chunks c ON c.source_id = s.id
    WHERE s.project_id = ${projectId} AND s.id = ${sourceId}
    GROUP BY s.id
  `);
  const row = rows.rows[0];

  if (!row) {
    throw new MaisterError("PRECONDITION", "Brain source not found");
  }

  return toBrainSourceDto(row);
}
