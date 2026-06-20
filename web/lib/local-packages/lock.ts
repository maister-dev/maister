import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { localPackageLockMinutes } from "@/lib/instance-config";

const log = pino({
  name: "local-packages/lock",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = NodePgDatabase<typeof schema>;

// FIXME(any): dual drizzle peer-dep variants (matches authz.ts). Optional db
// override lets integration tests pass a testcontainer connection.
function resolveDb(db?: Db): Db {
  return db ?? (getDb() as unknown as Db);
}

const lp = schema.localPackages;

// (ADR-093, D10) Session-scoped working-dir edit-lock. Mirrors
// runs.keepalive_until: acquired on editor open, refreshed by keep-alive, lazy
// stale-takeover (no sweeper). Holder label is a display name only — never the
// session id.
export type LockState = {
  held: boolean;
  heldByMe: boolean;
  holderLabel: string | null;
  expiresAt: Date | null;
};

function nextExpiry(): Date {
  return new Date(Date.now() + localPackageLockMinutes() * 60_000);
}

export async function readLockState(
  id: string,
  sessionId: string,
  db?: Db,
): Promise<LockState> {
  const rows = await resolveDb(db)
    .select({
      lockedBySession: lp.lockedBySession,
      lockExpiresAt: lp.lockExpiresAt,
      holderName: schema.users.name,
      holderEmail: schema.users.email,
    })
    .from(lp)
    .leftJoin(schema.users, eq(schema.users.id, lp.lockedByUserId))
    .where(eq(lp.id, id));

  const row = rows[0];

  if (!row) {
    return { held: false, heldByMe: false, holderLabel: null, expiresAt: null };
  }

  const live =
    row.lockedBySession != null &&
    row.lockExpiresAt != null &&
    row.lockExpiresAt.getTime() > Date.now();

  return {
    held: live,
    heldByMe: live && row.lockedBySession === sessionId,
    holderLabel: live ? (row.holderName ?? row.holderEmail ?? null) : null,
    expiresAt: live ? row.lockExpiresAt : null,
  };
}

// Acquire iff free, mine, or expired (lazy stale-takeover). heldByMe=false means
// another session holds a live lock (the editor renders read-only).
export async function acquireLock(
  id: string,
  userId: string,
  sessionId: string,
  db?: Db,
): Promise<LockState> {
  const expiresAt = nextExpiry();
  const updated = await resolveDb(db)
    .update(lp)
    .set({
      lockedByUserId: userId,
      lockedBySession: sessionId,
      lockExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(lp.id, id),
        or(
          isNull(lp.lockedBySession),
          eq(lp.lockedBySession, sessionId),
          isNull(lp.lockExpiresAt),
          lt(lp.lockExpiresAt, sql`now()`),
        ),
      ),
    )
    .returning({ id: lp.id });

  if (updated.length > 0) {
    log.debug({ id, userId, sessionId }, "edit-lock acquired/refreshed");

    return { held: true, heldByMe: true, holderLabel: null, expiresAt };
  }

  return readLockState(id, sessionId, db);
}

// Keep-alive: extend the TTL only if this session still holds a live lock.
export async function refreshLock(
  id: string,
  sessionId: string,
  db?: Db,
): Promise<LockState> {
  const expiresAt = nextExpiry();
  const updated = await resolveDb(db)
    .update(lp)
    .set({ lockExpiresAt: expiresAt, updatedAt: new Date() })
    .where(
      and(
        eq(lp.id, id),
        eq(lp.lockedBySession, sessionId),
        sql`${lp.lockExpiresAt} > now()`,
      ),
    )
    .returning({ id: lp.id });

  if (updated.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      "edit-lock expired or taken over by another session — reload",
    );
  }

  return { held: true, heldByMe: true, holderLabel: null, expiresAt };
}

// Guard every working-dir write: the caller's session must hold a live lock.
export async function assertHoldsLock(
  id: string,
  sessionId: string,
  db?: Db,
): Promise<void> {
  const rows = await resolveDb(db)
    .select({ id: lp.id })
    .from(lp)
    .where(
      and(
        eq(lp.id, id),
        eq(lp.lockedBySession, sessionId),
        sql`${lp.lockExpiresAt} > now()`,
      ),
    );

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      "edit-lock not held by this session — acquire the editor lock first",
    );
  }
}

// User-scoped variant of assertHoldsLock: SOME live session of `userId` holds
// the working-dir lock. The project-less assistant turn / recover paths do not
// carry the editor's lock session id, but the run is bound to its launching user
// — so "this user is still the live editor" is the enforceable invariant. A
// takeover by ANOTHER user flips `locked_by_user_id`, revoking the launcher's
// ability to drive writes into a working dir someone else now owns.
export async function assertUserHoldsLock(
  id: string,
  userId: string,
  db?: Db,
): Promise<void> {
  const rows = await resolveDb(db)
    .select({ id: lp.id })
    .from(lp)
    .where(
      and(
        eq(lp.id, id),
        eq(lp.lockedByUserId, userId),
        sql`${lp.lockExpiresAt} > now()`,
      ),
    );

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      "edit-lock not held — reopen the package editor to continue",
    );
  }
}

export async function releaseLock(
  id: string,
  sessionId: string,
  db?: Db,
): Promise<void> {
  await resolveDb(db)
    .update(lp)
    .set({
      lockedByUserId: null,
      lockedBySession: null,
      lockExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(lp.id, id), eq(lp.lockedBySession, sessionId)));
}
