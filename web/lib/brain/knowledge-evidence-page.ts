import "server-only";

import type { KnowledgeDatabase } from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeRecordSelector } from "./knowledge-records";
import type { KnowledgeRecordEvidence } from "./knowledge-read-types";

import { z } from "zod";
import { sql } from "drizzle-orm";
import pino from "pino";

import {
  knowledgePageInputSchema,
  type KnowledgePageInput,
} from "./knowledge-read-types";
import { resolveKnowledgePrincipal } from "./knowledge-access";
import {
  knowledgeCursorScope,
  parseKnowledgeCursor,
  signKnowledgeCursor,
} from "./knowledge-cursor";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "./knowledge-disclosure";
import { readKnowledgeRecord } from "./knowledge-records";
import { restrictionsForKnowledgeAccess } from "./knowledge-restrictions";
import { knowledgeRevisionSchema } from "./knowledge-types";

import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";

const log = pino({
  name: "brain:knowledge-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

const evidenceCursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().length(64),
    recordId: postgresTextSchema.min(1).max(128),
    revision: knowledgeRevisionSchema,
    offset: z.number().int().min(1).max(63),
  })
  .strict();

export type { KnowledgePageInput } from "./knowledge-read-types";
export { knowledgePageInputSchema } from "./knowledge-read-types";
export type KnowledgeEvidencePage = Readonly<{
  items: readonly KnowledgeRecordEvidence[];
  nextCursor: string | null;
}>;

/** A continuation retains the exact accepted revision, including when the current head changes. */
export async function getKnowledgeEvidencePage(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  selector: KnowledgeRecordSelector,
  input: KnowledgePageInput,
): Promise<KnowledgeEvidencePage> {
  const parsed = knowledgePageInputSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid knowledge evidence page");
  const { cursor: rawCursor, limit } = parsed.data;
  const cursor =
    rawCursor === undefined
      ? null
      : evidenceCursorSchema.safeParse(parseKnowledgeCursor(rawCursor));

  if (
    cursor !== null &&
    (!cursor.success ||
      cursor.data.recordId !== selector.recordId ||
      (selector.revision !== undefined &&
        selector.revision !== cursor.data.revision))
  )
    throw new MaisterError(
      "CONFIG",
      "Evidence cursor does not match the requested record revision",
    );
  const continuation = cursor?.success ? cursor.data : null;

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const consumer = await lockKnowledgeReadConsumer(tx, principal);
      const identity = await resolveKnowledgePrincipal(
        tx,
        principal,
        "knowledge:read",
      );
      const result = await readKnowledgeRecord(tx, principal, {
        recordId: selector.recordId,
        revision: continuation?.revision ?? selector.revision,
      });
      const scope = await knowledgeCursorScope(tx, principal, identity, {
        kind: "evidence",
        recordId: result.record.id,
        revision: result.record.revision,
        limit,
      });

      if (continuation !== null && continuation.scope !== scope)
        throw new MaisterError(
          "CONFIG",
          "Evidence cursor no longer matches this credential, filters or current authority",
        );
      const offset = continuation?.offset ?? 0;
      const items: KnowledgeRecordEvidence[] = [];
      let nextCursor: string | null = null;

      if (offset > result.evidence.length)
        throw new MaisterError(
          "CONFIG",
          "Evidence cursor exceeds its accepted revision",
        );
      for (
        let index = offset;
        index < result.evidence.length && items.length < limit;
        index++
      ) {
        const next =
          index + 1 < result.evidence.length
            ? signKnowledgeCursor({
                version: 1,
                scope,
                recordId: result.record.id,
                revision: result.record.revision,
                offset: index + 1,
              })
            : null;
        const candidate = {
          items: [...items, result.evidence[index]],
          nextCursor: next,
        };

        if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 131072) {
          if (items.length === 0)
            throw new MaisterError(
              "PRECONDITION",
              "Evidence entry exceeds the bounded page contract",
            );
          break;
        }
        items.push(result.evidence[index]);
        nextCursor = next;
      }
      await recordKnowledgeDisclosure(
        tx,
        consumer,
        restrictionsForKnowledgeAccess(result.access),
      );
      log.debug(
        {
          recordId: result.record.id,
          revision: result.record.revision,
          count: items.length,
          hasContinuation: nextCursor !== null,
        },
        "knowledge evidence disclosed",
      );

      return { items, nextCursor };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
