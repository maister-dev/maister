import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { PersonalKnowledgeCredential } from "@/lib/tokens/personal-knowledge";
import type { PrepareVaultAccess } from "./store";

import { parseAgentMemoryView } from "./commands";
import { loadHumanVaultLocation } from "./human-catalog";
import {
  parseVaultHistory,
  vaultHistory,
  vaultRevisionDetail,
} from "./history";
import { prepareHumanInstallationVault } from "./installation-access";
import { MEMORY_ROOT } from "./paths";
import { prepareHumanProjectVault } from "./project-access";
import { readVaultRevision, unavailableMemory } from "./store";
import { viewAgentMemory, viewAgentNote } from "./view";

import { lockPersonalKnowledgeCredential } from "@/lib/tokens/personal-knowledge";
import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";

const identifier = postgresTextSchema.min(1).max(192);

function requireSelector(value: string) {
  if (!identifier.safeParse(value).success)
    throw new MaisterError("CONFIG", "Invalid vault identity");
}

export function parseVaultReadQuery(request: Request, keys: readonly string[]) {
  const params = new URL(request.url).searchParams;

  if (
    params.size !== new Set(params.keys()).size ||
    [...params.keys()].some((key) => !keys.includes(key))
  )
    throw new MaisterError("CONFIG", "Invalid vault read selector");
  const limit = params.get("limit");
  const cursor = params.get("cursor") ?? undefined;

  if (
    (cursor !== undefined && (!cursor || cursor.length > 2048)) ||
    (limit !== null &&
      (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100))
  )
    throw new MaisterError("CONFIG", "Invalid vault pagination");

  return {
    path: params.get("path"),
    limit: limit === null ? undefined : Number(limit),
    cursor,
  };
}

async function humanLocation(
  tx: Db,
  credential: PersonalKnowledgeCredential,
  locationId: string,
) {
  await lockPersonalKnowledgeCredential(tx, credential, "agent_memory:read");
  const { location, vaultId } = await loadHumanVaultLocation(
    tx,
    credential.userId,
    locationId,
  );

  if (!location.allowedActions.includes("view")) throw unavailableMemory();
  const userId = credential.userId;
  const prepare =
    location.ownerKind === "project" && location.projectSlug
      ? prepareHumanProjectVault({
          userId,
          slug: location.projectSlug,
          agentId: location.agentId,
          action: "readRepoFiles",
        })
      : prepareHumanInstallationVault({
          userId,
          agentId: location.agentId,
          bindingId: location.bindingId,
          action: "read",
        });
  const scoped: PrepareVaultAccess = async (db) => {
    if (!vaultId) throw unavailableMemory();
    const access = await prepare(db);

    if (access.vaultId !== vaultId) throw unavailableMemory();

    return { ...access, principalKey: `personal:${credential.tokenId}` };
  };

  return { vaultId, prepare: scoped };
}

type NotePage = Awaited<ReturnType<typeof viewAgentNote>>;

async function noteResponse(db: Db, vaultId: string, page: NotePage) {
  const revision = await readVaultRevision(
    db,
    vaultId,
    page.noteId,
    page.revisionId,
  );
  const { author } = revision;

  return {
    id: page.noteId,
    revisionId: page.revisionId,
    path: page.path,
    sha256: page.hash,
    createdAt: revision.createdAt.toISOString(),
    author:
      "userId" in author
        ? author.userId
        : "agentId" in author
          ? author.agentId
          : null,
    content: page.content,
    nextCursor: page.nextCursor,
  };
}

export async function readPersonalVaultPath(
  db: Db,
  credential: PersonalKnowledgeCredential,
  locationId: string,
  query: ReturnType<typeof parseVaultReadQuery>,
) {
  const input = parseAgentMemoryView({ command: "view", ...query });

  return db.transaction(async (tx) => {
    const { vaultId, prepare } = await humanLocation(
      tx,
      credential,
      locationId,
    );

    if (!vaultId) {
      if (input.path !== MEMORY_ROOT || input.cursor) throw unavailableMemory();

      return {
        kind: "directory" as const,
        path: MEMORY_ROOT,
        entries: [],
        nextCursor: null,
      };
    }
    const page = await viewAgentMemory(tx, input, prepare);

    if (page.kind === "note")
      return { kind: page.kind, note: await noteResponse(tx, vaultId, page) };

    return {
      kind: page.kind,
      path: page.path,
      nextCursor: page.nextCursor,
      entries: page.entries.map(({ path, kind, noteId }) => ({
        path,
        kind: kind === "directory" ? ("folder" as const) : kind,
        noteId,
        name: path.slice(page.path.length + 1),
      })),
    };
  });
}

export async function readPersonalVaultNote(
  db: Db,
  credential: PersonalKnowledgeCredential,
  locationId: string,
  noteId: string,
  cursor?: string,
) {
  requireSelector(noteId);

  return db.transaction(async (tx) => {
    const { vaultId, prepare } = await humanLocation(
      tx,
      credential,
      locationId,
    );

    if (!vaultId) throw unavailableMemory();

    return noteResponse(
      tx,
      vaultId,
      await viewAgentNote(tx, { noteId, cursor }, prepare),
    );
  });
}

export async function listPersonalVaultRevisions(
  db: Db,
  credential: PersonalKnowledgeCredential,
  locationId: string,
  noteId: string,
  query: ReturnType<typeof parseVaultReadQuery>,
) {
  requireSelector(noteId);

  return db.transaction(async (tx) => {
    const { prepare } = await humanLocation(tx, credential, locationId);
    const history = await vaultHistory(
      tx,
      parseVaultHistory({ noteId, limit: query.limit, cursor: query.cursor }),
      prepare,
    );

    return {
      items: history.items.map(({ id, path, hash, createdAt, author }) => ({
        id,
        path,
        sha256: hash,
        createdAt,
        author,
      })),
      nextCursor: history.nextCursor,
    };
  });
}

export async function readPersonalVaultRevision(
  db: Db,
  credential: PersonalKnowledgeCredential,
  locationId: string,
  noteId: string,
  revisionId: string,
) {
  requireSelector(noteId);
  requireSelector(revisionId);

  return db.transaction(async (tx) => {
    const { prepare } = await humanLocation(tx, credential, locationId);
    const { revision, content } = await vaultRevisionDetail(
      tx,
      revisionId,
      prepare,
      noteId,
    );

    if (content === null) throw unavailableMemory();

    return {
      id: noteId,
      revisionId,
      path: revision.path,
      sha256: revision.hash,
      createdAt: revision.createdAt,
      author: revision.author,
      content,
      nextCursor: null,
    };
  });
}
