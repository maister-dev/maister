import "server-only";

import type { KnowledgeAccessCapture } from "@/lib/company/types";
import type { SqlTransaction } from "@/lib/db/sql-types";

import { z } from "zod";
import { sql } from "drizzle-orm";

import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors";

export type LibrarianKnowledgeContext = Readonly<{
  ownerId: string;
  turnId: string;
  conversationId: string;
  segmentId: string;
  contextEpoch: number;
  capture: KnowledgeAccessCapture;
}>;

export async function lockLibrarianKnowledgeContext(
  tx: SqlTransaction,
  tokenId: string,
  scope:
    | "knowledge:read"
    | "agent_memory:read"
    | "librarian:cards"
    | "librarian:history",
): Promise<LibrarianKnowledgeContext> {
  const [locators] = (
    await tx.execute(sql`
    SELECT turn.conversation_id FROM project_tokens token JOIN librarian_turns turn ON turn.id=token.librarian_turn_id
    WHERE token.id=${tokenId} AND token.token_kind='librarian'
  `)
  ).rows;
  const parsedLocator = z
    .object({ conversation_id: z.string() })
    .safeParse(locators);

  if (!parsedLocator.success) throw librarianReadDenied();
  const locator = parsedLocator.data;

  await tx.execute(
    sql`SELECT id FROM librarian_conversations WHERE id=${locator.conversation_id} FOR NO KEY UPDATE`,
  );
  const [row] = (
    await tx.execute(sql`
    SELECT c.user_id AS owner_id,t.id AS turn_id,t.segment_id,t.variant,t.knowledge_access,c.context_epoch
    FROM project_tokens token JOIN librarian_turns t ON t.id=token.librarian_turn_id AND t.token_id=token.id
    JOIN librarian_conversations c ON c.id=t.conversation_id AND c.user_id=token.owner_user_id
    JOIN librarian_context_snapshots s ON s.id=t.context_snapshot_id AND s.turn_id=t.id AND s.context_epoch=c.context_epoch
    JOIN users u ON u.id=c.user_id AND u.account_status='active' AND NOT u.must_change_password
    WHERE token.id=${tokenId} AND token.token_kind='librarian' AND token.project_id IS NULL AND token.agent_id IS NULL
      AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp() AND token.scopes ? ${scope}
      AND c.id=${locator.conversation_id} AND c.current_segment_id=t.segment_id AND c.reset_state='none'
      AND t.status='running' AND t.variant IN ('owner_message','explain')
    FOR NO KEY UPDATE OF t
  `)
  ).rows;
  const parsed = z
    .strictObject({
      owner_id: z.string(),
      turn_id: z.string(),
      segment_id: z.string(),
      variant: z.enum(["owner_message", "explain"]),
      context_epoch: z.number().int().nonnegative(),
      knowledge_access: z.unknown(),
    })
    .safeParse(row);

  if (!parsed.success) throw librarianReadDenied();
  const current = parsed.data;

  if (scope === "librarian:cards" && current.variant !== "owner_message")
    throw librarianReadDenied();
  const capture = knowledgeAccessCaptureSchema.safeParse(
    current.knowledge_access ?? {
      schemaVersion: 2,
      state: "complete",
      generation: 1,
      restrictions: [],
    },
  );

  if (!capture.success || capture.data.state !== "complete")
    throw new MaisterError(
      "PRECONDITION",
      "Librarian source context is unavailable",
    );

  return {
    ownerId: current.owner_id,
    turnId: current.turn_id,
    segmentId: current.segment_id,
    conversationId: locator.conversation_id,
    contextEpoch: current.context_epoch,
    capture: capture.data,
  };
}

function librarianReadDenied() {
  return new MaisterError(
    "UNAUTHORIZED",
    "A current owner-bound librarian turn is required",
  );
}
