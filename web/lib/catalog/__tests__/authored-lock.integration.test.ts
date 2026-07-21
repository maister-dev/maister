import type { AuthoredLockDb } from "@/lib/catalog/authored-lock";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquireLock,
  assertHoldsLock,
  assertNoForeignLiveLock,
  isLockableCapability,
  readLockState,
  refreshLock,
  releaseLock,
} from "@/lib/catalog/authored-lock";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;
let lockDb: AuthoredLockDb;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "authored_lock_test",
  });
  db = testDatabase.db;
  lockDb = db as unknown as AuthoredLockDb;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function insertUser(name: string | null): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.users).values({
    id,
    name,
    email: `${id}@example.test`,
    accountStatus: "active",
  });

  return id;
}

async function insertCapability(): Promise<string> {
  return (await insertCapabilityWithProject()).capId;
}

async function insertCapabilityWithProject(): Promise<{
  capId: string;
  projectId: string;
}> {
  const projectId = randomUUID();
  const projectSlug = `authored-lock-${projectId}`;

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: projectSlug,
    name: projectSlug,
    repoPath: `/tmp/${projectSlug}`,
    maisterYamlPath: `/tmp/${projectSlug}/maister.yaml`,
  });

  const capId = randomUUID();

  await db.insert(schema.authoredCapabilities).values({
    id: capId,
    projectId,
    kind: "flow",
    slug: `cap-${capId}`,
    title: "Lock fixture",
  });

  return { capId, projectId };
}

async function setLockExpiry(capId: string, expiresAt: Date): Promise<void> {
  await db
    .update(schema.authoredCapabilities)
    .set({ lockExpiresAt: expiresAt })
    .where(eq(schema.authoredCapabilities.id, capId));
}

async function readLockColumns(capId: string): Promise<{
  lockedByUserId: string | null;
  lockedBySession: string | null;
  lockExpiresAt: Date | null;
}> {
  const rows = await db
    .select({
      lockedByUserId: schema.authoredCapabilities.lockedByUserId,
      lockedBySession: schema.authoredCapabilities.lockedBySession,
      lockExpiresAt: schema.authoredCapabilities.lockExpiresAt,
    })
    .from(schema.authoredCapabilities)
    .where(eq(schema.authoredCapabilities.id, capId));

  return rows[0];
}

async function captureError(op: () => Promise<unknown>): Promise<MaisterError> {
  try {
    await op();
  } catch (err) {
    expect(err).toBeInstanceOf(MaisterError);

    return err as MaisterError;
  }

  throw new Error("expected the operation to throw");
}

describe("authored capability edit-lock", () => {
  it("reports a capability with no lock as free", async () => {
    const capId = await insertCapability();

    expect(await readLockState(capId, "s1", lockDb)).toEqual({
      held: false,
      heldByMe: false,
      holderLabel: null,
      expiresAt: null,
    });
  });

  it("acquires the lock and reports it held by the acquiring session", async () => {
    const capId = await insertCapability();
    const userId = await insertUser("Ada Lovelace");

    const acquired = await acquireLock(capId, userId, "s1", lockDb);

    expect(acquired.held).toBe(true);
    expect(acquired.heldByMe).toBe(true);
    expect(acquired.expiresAt).toBeInstanceOf(Date);

    const columns = await readLockColumns(capId);

    expect(columns.lockedByUserId).toBe(userId);
    expect(columns.lockedBySession).toBe("s1");

    const mine = await readLockState(capId, "s1", lockDb);

    expect(mine).toMatchObject({
      held: true,
      heldByMe: true,
      holderLabel: "Ada Lovelace",
    });
  });

  it("renders read-only for a foreign session and exposes the holder label", async () => {
    const capId = await insertCapability();
    const userId = await insertUser("Ada Lovelace");

    await acquireLock(capId, userId, "s1", lockDb);

    expect(await readLockState(capId, "other", lockDb)).toMatchObject({
      held: true,
      heldByMe: false,
      holderLabel: "Ada Lovelace",
    });
  });

  it("falls back to the holder email when the user has no name", async () => {
    const capId = await insertCapability();
    const userId = await insertUser(null);

    await acquireLock(capId, userId, "s1", lockDb);

    const state = await readLockState(capId, "other", lockDb);

    expect(state.holderLabel).toBe(`${userId}@example.test`);
  });

  it("lets the same user take over from a different session", async () => {
    const capId = await insertCapability();
    const userId = await insertUser("Ada Lovelace");

    await acquireLock(capId, userId, "s1", lockDb);

    const takeover = await acquireLock(capId, userId, "s2", lockDb);

    expect(takeover.heldByMe).toBe(true);
    expect((await readLockColumns(capId)).lockedBySession).toBe("s2");
  });

  it("refuses a foreign acquire while the lock is live without throwing", async () => {
    const capId = await insertCapability();
    const holder = await insertUser("Ada Lovelace");
    const intruder = await insertUser("Grace Hopper");

    await acquireLock(capId, holder, "s1", lockDb);

    const attempt = await acquireLock(capId, intruder, "s2", lockDb);

    expect(attempt).toMatchObject({
      held: true,
      heldByMe: false,
      holderLabel: "Ada Lovelace",
    });
    expect((await readLockColumns(capId)).lockedBySession).toBe("s1");
  });

  it("allows a foreign acquire once the lock expired (lazy stale takeover)", async () => {
    const capId = await insertCapability();
    const holder = await insertUser("Ada Lovelace");
    const successor = await insertUser("Grace Hopper");

    await acquireLock(capId, holder, "s1", lockDb);
    await setLockExpiry(capId, new Date(Date.now() - 60_000));

    const takeover = await acquireLock(capId, successor, "s2", lockDb);

    expect(takeover.heldByMe).toBe(true);

    const columns = await readLockColumns(capId);

    expect(columns.lockedByUserId).toBe(successor);
    expect(columns.lockedBySession).toBe("s2");
  });

  it("extends the TTL on refresh for the live owning session", async () => {
    const capId = await insertCapability();
    const userId = await insertUser("Ada Lovelace");

    await acquireLock(capId, userId, "s1", lockDb);
    await setLockExpiry(capId, new Date(Date.now() + 60_000));

    const refreshed = await refreshLock(capId, "s1", lockDb);

    expect(refreshed.heldByMe).toBe(true);
    expect(refreshed.expiresAt!.getTime()).toBeGreaterThan(
      Date.now() + 20 * 60_000,
    );
  });

  it("throws CONFLICT when refreshing without a live owning lock", async () => {
    const capId = await insertCapability();
    const userId = await insertUser("Ada Lovelace");

    await acquireLock(capId, userId, "s1", lockDb);

    const foreign = await captureError(() => refreshLock(capId, "s2", lockDb));

    expect(foreign.code).toBe("CONFLICT");

    await setLockExpiry(capId, new Date(Date.now() - 60_000));

    const expired = await captureError(() => refreshLock(capId, "s1", lockDb));

    expect(expired.code).toBe("CONFLICT");
  });

  it("fences release to the holding session", async () => {
    const capId = await insertCapability();
    const userId = await insertUser("Ada Lovelace");

    await acquireLock(capId, userId, "s1", lockDb);
    await releaseLock(capId, "s2", lockDb);

    expect((await readLockColumns(capId)).lockedBySession).toBe("s1");

    await releaseLock(capId, "s1", lockDb);

    const cleared = await readLockColumns(capId);

    expect(cleared.lockedBySession).toBeNull();
    expect(cleared.lockedByUserId).toBeNull();
    expect(cleared.lockExpiresAt).toBeNull();
  });

  it("asserts the holding session and refuses everyone else", async () => {
    const capId = await insertCapability();
    const userId = await insertUser("Ada Lovelace");

    await acquireLock(capId, userId, "s1", lockDb);

    await expect(assertHoldsLock(capId, "s1", lockDb)).resolves.toBeUndefined();

    const foreign = await captureError(() =>
      assertHoldsLock(capId, "s2", lockDb),
    );

    expect(foreign.code).toBe("CONFLICT");
    expect(foreign.details).toMatchObject({ reason: "edit_lock_not_held" });

    await setLockExpiry(capId, new Date(Date.now() - 60_000));

    const expired = await captureError(() =>
      assertHoldsLock(capId, "s1", lockDb),
    );

    expect(expired.details).toMatchObject({ reason: "edit_lock_not_held" });
  });

  it("refuses a headless write only when another user holds a live lock", async () => {
    const capId = await insertCapability();
    const holder = await insertUser("Ada Lovelace");
    const other = await insertUser("Grace Hopper");

    await expect(
      assertNoForeignLiveLock(capId, other, lockDb),
    ).resolves.toBeUndefined();

    await acquireLock(capId, holder, "s1", lockDb);

    await expect(
      assertNoForeignLiveLock(capId, holder, lockDb),
    ).resolves.toBeUndefined();

    const foreign = await captureError(() =>
      assertNoForeignLiveLock(capId, other, lockDb),
    );

    expect(foreign.code).toBe("CONFLICT");
    expect(foreign.details).toMatchObject({ reason: "edit_lock_not_held" });

    await setLockExpiry(capId, new Date(Date.now() - 60_000));

    await expect(
      assertNoForeignLiveLock(capId, other, lockDb),
    ).resolves.toBeUndefined();
  });

  it("treats missing, foreign-project, and ARCHIVED capabilities as not lockable", async () => {
    const { capId, projectId } = await insertCapabilityWithProject();

    expect(await isLockableCapability(projectId, capId, lockDb)).toBe(true);
    expect(await isLockableCapability(projectId, randomUUID(), lockDb)).toBe(
      false,
    );
    expect(await isLockableCapability(randomUUID(), capId, lockDb)).toBe(false);

    await db
      .update(schema.authoredCapabilities)
      .set({ lifecycle: "ARCHIVED" })
      .where(eq(schema.authoredCapabilities.id, capId));

    expect(await isLockableCapability(projectId, capId, lockDb)).toBe(false);
  });

  it("honors a transaction handle so the seam sees uncommitted lock state", async () => {
    const capId = await insertCapability();
    const holder = await insertUser("Ada Lovelace");
    const other = await insertUser("Grace Hopper");

    await db.transaction(async (tx) => {
      const txDb = tx as unknown as AuthoredLockDb;

      await acquireLock(capId, holder, "s1", txDb);

      await expect(assertHoldsLock(capId, "s1", txDb)).resolves.toBeUndefined();

      const foreign = await captureError(() =>
        assertNoForeignLiveLock(capId, other, txDb),
      );

      expect(foreign.details).toMatchObject({ reason: "edit_lock_not_held" });
    });

    expect((await readLockColumns(capId)).lockedBySession).toBe("s1");
  });
});
