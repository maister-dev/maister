import "server-only";

import type {
  KnowledgeTransaction,
  KnowledgePrincipalIdentity,
} from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";

import { sql } from "drizzle-orm";

import {
  signCursorPayload,
  parseCursorPayload,
  encodeKeysetCursor,
  decodeKeysetCursor,
  type KeysetCursor,
} from "@/lib/keyset-cursor";
import { contentDigest } from "@/lib/evaluations/digest";

const namespace = "maister.knowledge.v1";

export type KnowledgeCursor = KeysetCursor;

export function signKnowledgeCursor(
  value: Readonly<Record<string, unknown>>,
): string {
  return signCursorPayload(namespace, value);
}

export function parseKnowledgeCursor(raw: string): unknown {
  return parseCursorPayload(namespace, raw);
}

export function encodeKnowledgeCursor(cursor: KnowledgeCursor): string {
  return encodeKeysetCursor(namespace, cursor);
}

export function decodeKnowledgeCursor(
  raw: string,
  scope: string,
): KnowledgeCursor {
  return decodeKeysetCursor(namespace, raw, scope);
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

  const initiatingPolicy =
    identity.kind === "company_agent"
      ? {
          grants: (
            await tx.execute(
              sql`SELECT id,company_id,action,revision FROM company_grants WHERE principal_type='user' AND principal_id=${identity.initiatingUser.id} AND revoked_at IS NULL ORDER BY id FOR SHARE`,
            )
          ).rows,
          recordGrants: (
            await tx.execute(
              sql`SELECT record_id,action FROM brain_record_grants WHERE principal_type='user' AND principal_id=${identity.initiatingUser.id} AND revoked_at IS NULL ORDER BY record_id,action FOR SHARE`,
            )
          ).rows,
        }
      : null;

  return contentDigest({
    principal,
    identity,
    grants,
    memberships,
    recordGrants,
    ...(initiatingPolicy === null ? {} : { initiatingPolicy }),
    filters,
  });
}
