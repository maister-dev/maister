import "server-only";

import type {
  KnowledgeTransaction,
  KnowledgePrincipalIdentity,
} from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";

import { timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { cursorSignature } from "@/lib/cursor-signature";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

const namespace = "maister.knowledge.v1";
const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().length(64),
    upper: z.string().datetime({ precision: 6 }),
    at: z.string().datetime({ precision: 6 }),
    id: z.string().min(1).max(128),
  })
  .strict();

export type KnowledgeCursor = Readonly<z.infer<typeof cursorSchema>>;

export function signKnowledgeCursor(
  value: Readonly<Record<string, unknown>>,
): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${payload}.${cursorSignature(namespace, payload).toString("base64url")}`;
}

export function parseKnowledgeCursor(raw: string): unknown {
  const parts = raw.split(".");

  if (
    raw.length > 2048 ||
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  )
    throw new MaisterError("CONFIG", "Invalid knowledge cursor");
  const expected = cursorSignature(namespace, parts[0]);
  const actual = Buffer.from(parts[1], "base64url");

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new MaisterError("CONFIG", "Invalid knowledge cursor signature");

  try {
    return JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw new MaisterError("CONFIG", "Invalid knowledge cursor payload");
  }
}

export function encodeKnowledgeCursor(cursor: KnowledgeCursor): string {
  return signKnowledgeCursor(cursorSchema.parse(cursor));
}

export function decodeKnowledgeCursor(
  raw: string,
  scope: string,
): KnowledgeCursor {
  const parsed = cursorSchema.safeParse(parseKnowledgeCursor(raw));

  if (
    !parsed.success ||
    parsed.data.scope !== scope ||
    parsed.data.at > parsed.data.upper
  )
    throw new MaisterError(
      "CONFIG",
      "Knowledge cursor no longer matches this credential, filters or current authority",
    );

  return parsed.data;
}

/** Current principal policy is part of the cursor; per-record/source policy is also rechecked on every page. */
export async function knowledgeCursorScope(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  identity: KnowledgePrincipalIdentity,
  filters: unknown,
): Promise<string> {
  const grants = (
    await tx.execute(
      sql`SELECT id,company_id,action,revision FROM company_grants WHERE principal_type=${identity.actor.kind} AND principal_id=${identity.actor.id} AND revoked_at IS NULL ORDER BY id FOR SHARE`,
    )
  ).rows;
  const memberships =
    identity.kind === "user"
      ? (
          await tx.execute(
            sql`SELECT id,project_id,role FROM project_members WHERE user_id=${identity.user.id} ORDER BY id FOR SHARE`,
          )
        ).rows
      : [];
  const recordGrants = (
    await tx.execute(
      sql`SELECT record_id,action FROM brain_record_grants WHERE principal_type=${identity.actor.kind} AND principal_id=${identity.actor.id} AND revoked_at IS NULL ORDER BY record_id,action FOR SHARE`,
    )
  ).rows;

  return contentDigest({
    principal,
    identity,
    grants,
    memberships,
    recordGrants,
    filters,
  });
}
