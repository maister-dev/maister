import "server-only";

import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { Db } from "@/lib/execution-host/db";

import { and, eq, inArray } from "drizzle-orm";

import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { librarianConversations, librarianTurns } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

type LibrarianSources = readonly KnowledgeAccessRestriction[];

export function librarianProjectSources(
  projectIds: readonly string[],
): LibrarianSources {
  return [...new Set(projectIds)].map((projectId) => ({
    kind: "project_visibility",
    projectId,
  }));
}

export function librarianMessageSources(
  message: {
    authorKind: string;
    sourceProjectIds: readonly string[];
    turnId: string | null;
  },
  turnSources: ReadonlyMap<string, LibrarianSources | null>,
): LibrarianSources | null {
  if (message.authorKind === "owner") return [];
  const exact = message.turnId ? turnSources.get(message.turnId) : [];

  if (!exact) return null;

  return [...exact, ...librarianProjectSources(message.sourceProjectIds)];
}

/** Lock coarse sources before committing a context that uses them. */
export async function recheckLibrarianProjects(
  tx: Db,
  ownerId: string,
  sources: LibrarianSources,
): Promise<void> {
  const projectIds = sources.flatMap((source) =>
    source.kind === "project_visibility" ? [source.projectId] : [],
  );

  if (projectIds.length === 0) return;
  await authorizeSourceRestrictions(
    tx,
    { kind: "user", userId: ownerId },
    librarianProjectSources(projectIds),
  );
}

export async function visibleLibrarianCapture(
  tx: Db,
  ownerId: string,
  capture: unknown,
): Promise<readonly KnowledgeAccessRestriction[] | null> {
  if (capture === null) return [];
  const checked = knowledgeAccessCaptureSchema.safeParse(capture);

  if (!checked.success || checked.data.state !== "complete") return null;
  try {
    await authorizeSourceRestrictions(
      tx,
      { kind: "user", userId: ownerId },
      checked.data.restrictions,
    );

    return checked.data.restrictions;
  } catch (error) {
    if (!isMaisterError(error)) throw error;

    return null;
  }
}

/** Existing replies can have no source capture. A missing or malformed turn is never disclosed. */
export async function visibleLibrarianTurnSources(
  tx: Db,
  ownerId: string,
  turnIds: readonly string[],
) {
  const result = new Map<string, readonly KnowledgeAccessRestriction[] | null>(
    turnIds.map((id) => [id, null]),
  );

  if (turnIds.length === 0) return result;
  const selected = await tx
    .select({
      id: librarianTurns.id,
      knowledgeAccess: librarianTurns.knowledgeAccess,
    })
    .from(librarianTurns)
    .innerJoin(
      librarianConversations,
      eq(librarianConversations.id, librarianTurns.conversationId),
    )
    .where(
      and(
        eq(librarianConversations.userId, ownerId),
        inArray(librarianTurns.id, [...result.keys()]),
      ),
    );

  for (const turn of selected) {
    result.set(
      turn.id,
      await visibleLibrarianCapture(tx, ownerId, turn.knowledgeAccess),
    );
  }

  return result;
}
