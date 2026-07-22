import "server-only";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { localPackageLockMinutes } from "@/lib/instance-config";

const log = pino({
  name: "catalog/authored-lock",
  level: process.env.LOG_LEVEL ?? "info",
});

// (ADR-149) Session-scoped authored-capability edit-lock — the twin of
// `local-packages/lock.ts` over the `authored_capabilities` lock columns. It
// takes the catalog module's structural db handle (not a NodePgDatabase) so
// every assert can run ON the `draft_version` CAS transaction handle. The lock
// is coordination/UX; the CAS stays the correctness backstop.
// Project scoping is the CALLER's precondition, not a predicate here: routes
// resolve the project from the URL and gate on `isLockableCapability(projectId,
// capId)` before touching any lock. Re-asserting `project_id` in every
// statement below would only guard against a capability changing projects
// mid-request — and `authored_capabilities.project_id` is never updated
// anywhere in the codebase. Keep that true, or these helpers need the scope.
export type AuthoredLockDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

// Holder label is a display name only — never the session id.
export type LockState = {
  held: boolean;
  heldByMe: boolean;
  holderLabel: string | null;
  expiresAt: Date | null;
};

type LockRow = {
  locked_by_user_id: string | null;
  locked_by_session: string | null;
  lock_expires_at: Date | string | null;
  holder_name: string | null;
  holder_email: string | null;
};

function resolveDb(db?: AuthoredLockDb): AuthoredLockDb {
  return db ?? (getDb() as unknown as AuthoredLockDb);
}

function rowsOf<T>(result: { rows?: unknown[] }): T[] {
  return (result.rows ?? []) as T[];
}

function nextExpiry(): Date {
  return new Date(Date.now() + localPackageLockMinutes() * 60_000);
}

// Lock-route precondition. Missing, foreign-project, and ARCHIVED all read as
// "not lockable" so the routes answer a uniform 404 without leaking whether a
// capability exists in another project.
export async function isLockableCapability(
  projectId: string,
  capId: string,
  db?: AuthoredLockDb,
): Promise<boolean> {
  const result = await resolveDb(db).execute(sql`
    SELECT id
    FROM authored_capabilities
    WHERE id = ${capId}
      AND project_id = ${projectId}
      AND lifecycle <> 'ARCHIVED'
    LIMIT 1
  `);

  return rowsOf<{ id: string }>(result).length > 0;
}

export async function readLockState(
  capId: string,
  sessionId: string,
  db?: AuthoredLockDb,
): Promise<LockState> {
  const result = await resolveDb(db).execute(sql`
    SELECT c.locked_by_user_id,
           c.locked_by_session,
           c.lock_expires_at,
           u.name  AS holder_name,
           u.email AS holder_email
    FROM authored_capabilities c
    LEFT JOIN users u ON u.id = c.locked_by_user_id
    WHERE c.id = ${capId}
    LIMIT 1
  `);
  const row = rowsOf<LockRow>(result)[0];

  if (!row) {
    return { held: false, heldByMe: false, holderLabel: null, expiresAt: null };
  }

  const expiresAt = row.lock_expires_at ? new Date(row.lock_expires_at) : null;
  // `locked_by_user_id` is part of liveness, not just display: the FK is
  // ON DELETE SET NULL, so deleting the holder orphans a row that still has a
  // session id and an unexpired TTL. Without this arm the row reads "held" here
  // (and is un-acquirable, since no acquire disjunct matches an orphan) while
  // `assertNoForeignLiveLock` reads it as free — the two disagree for a full
  // TTL. Orphaned lock == free lock, uniformly.
  const live =
    row.locked_by_user_id != null &&
    row.locked_by_session != null &&
    expiresAt != null &&
    expiresAt.getTime() > Date.now();

  return {
    held: live,
    heldByMe: live && row.locked_by_session === sessionId,
    holderLabel: live ? (row.holder_name ?? row.holder_email ?? null) : null,
    expiresAt: live ? expiresAt : null,
  };
}

// Acquire iff free, this session, this user, or expired (lazy stale takeover) —
// but never on an ARCHIVED row: archiving clears the lock columns and an
// immutable row is not editable, so an acquire racing an archive must not
// re-stamp a lock that `lock-refresh`/`lock-release` (both 404 once ARCHIVED)
// could never clear. heldByMe=false means another user holds a live lock — the
// editor renders read-only. That is a state, not an error, so this never throws.
export async function acquireLock(
  capId: string,
  userId: string,
  sessionId: string,
  db?: AuthoredLockDb,
): Promise<LockState> {
  const handle = resolveDb(db);
  const expiresAt = nextExpiry();
  const updated = await handle.execute(sql`
    UPDATE authored_capabilities
    SET locked_by_user_id = ${userId},
        locked_by_session = ${sessionId},
        lock_expires_at = ${expiresAt}
    WHERE id = ${capId}
      AND lifecycle <> 'ARCHIVED'
      AND (
        locked_by_session IS NULL
        OR locked_by_session = ${sessionId}
        OR locked_by_user_id = ${userId}
        OR locked_by_user_id IS NULL
        OR lock_expires_at IS NULL
        OR lock_expires_at < now()
      )
    RETURNING id
  `);

  if (rowsOf<{ id: string }>(updated).length > 0) {
    log.debug(
      { capId, userId, sessionId },
      "authored edit-lock acquired/refreshed",
    );

    return { held: true, heldByMe: true, holderLabel: null, expiresAt };
  }

  return readLockState(capId, sessionId, handle);
}

// Keep-alive: extend the TTL only if this session still holds a live lock.
// `userId` is matched too, not just the session: the session id is a client-
// minted bearer token, so binding it to the authenticated user stops a leaked
// session string from being replayed by a different user to keep a lock alive.
export async function refreshLock(
  capId: string,
  sessionId: string,
  userId: string,
  db?: AuthoredLockDb,
): Promise<LockState> {
  const expiresAt = nextExpiry();
  const updated = await resolveDb(db).execute(sql`
    UPDATE authored_capabilities
    SET lock_expires_at = ${expiresAt}
    WHERE id = ${capId}
      AND locked_by_session = ${sessionId}
      AND locked_by_user_id = ${userId}
      AND lock_expires_at > now()
    RETURNING id
  `);

  if (rowsOf<{ id: string }>(updated).length === 0) {
    log.warn({ capId, sessionId }, "authored edit-lock refresh rejected");

    throw new MaisterError(
      "CONFLICT",
      "edit-lock expired or taken over by another session — reload",
      { details: { reason: "edit_lock_not_held" } },
    );
  }

  return { held: true, heldByMe: true, holderLabel: null, expiresAt };
}

// Guard an interactive write: the caller's session must hold a live lock, and
// that lock must belong to the caller's own user (the session id alone is a
// client-minted bearer token — pairing it with `userId` blocks a leaked session
// from writing through another user's lock).
export async function assertHoldsLock(
  capId: string,
  sessionId: string,
  userId: string,
  db?: AuthoredLockDb,
): Promise<void> {
  const result = await resolveDb(db).execute(sql`
    SELECT id
    FROM authored_capabilities
    WHERE id = ${capId}
      AND locked_by_session = ${sessionId}
      AND locked_by_user_id = ${userId}
      AND lock_expires_at > now()
    LIMIT 1
  `);

  if (rowsOf<{ id: string }>(result).length === 0) {
    throw new MaisterError(
      "CONFLICT",
      "edit-lock not held by this session — acquire the editor lock first",
      { details: { reason: "edit_lock_not_held" } },
    );
  }
}

// Headless variant for callers that carry no session id (PATCH route without
// the hidden field, publish/archive with empty bodies, CLI import, brain
// auto-draft): refuse ONLY when another user holds a LIVE lock. A free, expired,
// or own-user lock keeps today's behavior, so a no-JS submit degrades gracefully.
export async function assertNoForeignLiveLock(
  capId: string,
  userId: string,
  db?: AuthoredLockDb,
): Promise<void> {
  const result = await resolveDb(db).execute(sql`
    SELECT id
    FROM authored_capabilities
    WHERE id = ${capId}
      AND locked_by_user_id IS NOT NULL
      AND locked_by_user_id <> ${userId}
      AND lock_expires_at > now()
    LIMIT 1
  `);

  if (rowsOf<{ id: string }>(result).length > 0) {
    log.warn({ capId, userId }, "authored write refused — foreign edit-lock");

    throw new MaisterError(
      "CONFLICT",
      "another user holds the edit-lock on this capability",
      { details: { reason: "edit_lock_not_held" } },
    );
  }
}

export async function releaseLock(
  capId: string,
  sessionId: string,
  userId: string,
  db?: AuthoredLockDb,
): Promise<void> {
  await resolveDb(db).execute(sql`
    UPDATE authored_capabilities
    SET locked_by_user_id = NULL,
        locked_by_session = NULL,
        lock_expires_at = NULL
    WHERE id = ${capId}
      AND locked_by_session = ${sessionId}
      AND locked_by_user_id = ${userId}
  `);
}
