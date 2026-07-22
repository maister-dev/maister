import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireLock } from "@/lib/catalog/authored-lock";
import {
  archiveAuthoredCapability,
  createAuthoredCapability,
  publishAuthoredCapabilityLocal,
  updateAuthoredDraft,
} from "@/lib/catalog/authored-service";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "authored_lock_seam_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function insertUser(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.users).values({
    id,
    name: `user-${id.slice(0, 6)}`,
    email: `${id}@example.test`,
    accountStatus: "active",
  });

  return id;
}

async function seedCapability(): Promise<{
  projectSlug: string;
  capId: string;
}> {
  const projectId = randomUUID();
  const projectSlug = `seam-${projectId}`;

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: projectSlug,
    name: projectSlug,
    repoPath: `/tmp/${projectSlug}`,
    maisterYamlPath: `/tmp/${projectSlug}/maister.yaml`,
  });

  const created = await createAuthoredCapability({
    projectSlug,
    input: {
      kind: "rule",
      slug: `rule-${randomUUID().slice(0, 8)}`,
      title: "Seam fixture",
      body: { content: "original" },
    },
    db,
  });

  return { projectSlug, capId: created.capability.id };
}

async function expireLock(capId: string): Promise<void> {
  await db
    .update(schema.authoredCapabilities)
    .set({ lockExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.authoredCapabilities.id, capId));
}

async function draftVersionOf(capId: string): Promise<number> {
  const rows = await db
    .select({ draftVersion: schema.authoredCapabilities.draftVersion })
    .from(schema.authoredCapabilities)
    .where(eq(schema.authoredCapabilities.id, capId));

  return rows[0].draftVersion;
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

function saveArgs(
  projectSlug: string,
  capId: string,
  expectedDraftVersion: number,
  editor?: { sessionId?: string; userId?: string },
) {
  return {
    projectSlug,
    capId,
    input: { title: "Seam edit", expectedDraftVersion },
    editor,
    db,
  };
}

describe("authored edit-lock seam inside the draft_version CAS", () => {
  it("(a) lets the lock holder save with its sessionId", async () => {
    const { projectSlug, capId } = await seedCapability();
    const userId = await insertUser();

    await acquireLock(capId, userId, "s1", db);

    const before = await draftVersionOf(capId);

    await updateAuthoredDraft(
      saveArgs(projectSlug, capId, before, { sessionId: "s1", userId }),
    );

    expect(await draftVersionOf(capId)).toBe(before + 1);
  });

  it("(b) refuses a sessionId that does not hold the lock", async () => {
    const { projectSlug, capId } = await seedCapability();
    const holder = await insertUser();
    const intruder = await insertUser();

    await acquireLock(capId, holder, "s1", db);

    const before = await draftVersionOf(capId);
    const err = await captureError(() =>
      updateAuthoredDraft(
        saveArgs(projectSlug, capId, before, {
          sessionId: "s2",
          userId: intruder,
        }),
      ),
    );

    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({ reason: "edit_lock_not_held" });
    expect(await draftVersionOf(capId)).toBe(before);
  });

  it("(c) keeps today's behavior for a headless save on a free lock", async () => {
    const { projectSlug, capId } = await seedCapability();
    const userId = await insertUser();

    const before = await draftVersionOf(capId);

    await updateAuthoredDraft(saveArgs(projectSlug, capId, before, { userId }));

    expect(await draftVersionOf(capId)).toBe(before + 1);
  });

  it("(c2) keeps today's behavior for a headless save on an expired lock", async () => {
    const { projectSlug, capId } = await seedCapability();
    const holder = await insertUser();
    const other = await insertUser();

    await acquireLock(capId, holder, "s1", db);
    await expireLock(capId);

    const before = await draftVersionOf(capId);

    await updateAuthoredDraft(
      saveArgs(projectSlug, capId, before, { userId: other }),
    );

    expect(await draftVersionOf(capId)).toBe(before + 1);
  });

  it("(d) refuses a headless save while another user holds a live lock", async () => {
    const { projectSlug, capId } = await seedCapability();
    const holder = await insertUser();
    const other = await insertUser();

    await acquireLock(capId, holder, "s1", db);

    const before = await draftVersionOf(capId);
    const err = await captureError(() =>
      updateAuthoredDraft(
        saveArgs(projectSlug, capId, before, { userId: other }),
      ),
    );

    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({ reason: "edit_lock_not_held" });
    expect(await draftVersionOf(capId)).toBe(before);
  });

  it("(e) still gives the lock holder the stale-draft CONFLICT (CAS preserved)", async () => {
    const { projectSlug, capId } = await seedCapability();
    const userId = await insertUser();

    await acquireLock(capId, userId, "s1", db);

    // The REAL stale case: this session read version V, a save moved the row to
    // V+1, and the editor still submits V. A version from the future
    // (`actual + N`) also throws, but on a value that never existed — it would
    // not catch an implementation that rejected only FORWARD mismatches.
    const stale = await draftVersionOf(capId);

    await updateAuthoredDraft(
      saveArgs(projectSlug, capId, stale, { sessionId: "s1", userId }),
    );

    const current = await draftVersionOf(capId);

    expect(current).toBe(stale + 1);

    const err = await captureError(() =>
      updateAuthoredDraft(
        saveArgs(projectSlug, capId, stale, {
          sessionId: "s1",
          userId,
        }),
      ),
    );

    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("stale authored capability draft");
    // The lock holder's refusal is the CAS one, never `edit_lock_not_held` —
    // that is what "the CAS is preserved under the lock" means.
    expect(err.details?.reason).toBeUndefined();
    expect(await draftVersionOf(capId)).toBe(current);
  });

  it("(f) gates publish on the same seam", async () => {
    const { projectSlug, capId } = await seedCapability();
    const holder = await insertUser();
    const other = await insertUser();

    await acquireLock(capId, holder, "s1", db);

    const foreign = await captureError(() =>
      publishAuthoredCapabilityLocal({
        projectSlug,
        capId,
        editor: { userId: other },
        db,
      }),
    );

    expect(foreign.details).toMatchObject({ reason: "edit_lock_not_held" });

    const published = await publishAuthoredCapabilityLocal({
      projectSlug,
      capId,
      editor: { sessionId: "s1", userId: holder },
      db,
    });

    expect(published.revision.lifecycle).toBe("PUBLISHED");
  });

  it("(f2) refuses archive while another user holds a live lock", async () => {
    const { projectSlug, capId } = await seedCapability();
    const holder = await insertUser();
    const other = await insertUser();

    await acquireLock(capId, holder, "s1", db);

    const err = await captureError(() =>
      archiveAuthoredCapability({
        projectSlug,
        capId,
        editor: { userId: other },
        db,
      }),
    );

    expect(err.details).toMatchObject({ reason: "edit_lock_not_held" });

    const archived = await archiveAuthoredCapability({
      projectSlug,
      capId,
      editor: { userId: holder },
      db,
    });

    expect(archived.lifecycle).toBe("ARCHIVED");
  });

  it("(g) re-archiving is an idempotent no-op even under a foreign live lock", async () => {
    const { projectSlug, capId } = await seedCapability();
    const holder = await insertUser();
    const other = await insertUser();

    await archiveAuthoredCapability({
      projectSlug,
      capId,
      editor: { userId: other },
      db,
    });

    // The already-ARCHIVED early return runs BEFORE the lock assert, so a
    // second archive cannot be refused — it mutates nothing. Documented as its
    // own row in the capability-catalog gating table.
    await acquireLock(capId, holder, "s1", db);

    const again = await archiveAuthoredCapability({
      projectSlug,
      capId,
      editor: { userId: other },
      db,
    });

    expect(again.lifecycle).toBe("ARCHIVED");
  });

  it("(h) archiving clears the edit-lock columns", async () => {
    const { projectSlug, capId } = await seedCapability();
    const holder = await insertUser();

    await acquireLock(capId, holder, "s1", db);
    await archiveAuthoredCapability({
      projectSlug,
      capId,
      editor: { userId: holder },
      db,
    });

    // An ARCHIVED row is not lockable, so a surviving lock could never be
    // refreshed or released — it would read as "held" forever.
    const rows = await db
      .select({
        lockedByUserId: schema.authoredCapabilities.lockedByUserId,
        lockedBySession: schema.authoredCapabilities.lockedBySession,
        lockExpiresAt: schema.authoredCapabilities.lockExpiresAt,
      })
      .from(schema.authoredCapabilities)
      .where(eq(schema.authoredCapabilities.id, capId));

    expect(rows[0]).toEqual({
      lockedByUserId: null,
      lockedBySession: null,
      lockExpiresAt: null,
    });
  });

  it("(i) refuses an ARCHIVED-cap save with 'immutable', not edit_lock_not_held", async () => {
    const { projectSlug, capId } = await seedCapability();
    const holder = await insertUser();

    await acquireLock(capId, holder, "s1", db);
    await archiveAuthoredCapability({
      projectSlug,
      capId,
      editor: { userId: holder },
      db,
    });

    // Immutability is checked BEFORE the lock assert, so a would-be holder
    // submitting `sessionId` on a concurrently-archived cap gets the "immutable"
    // reason — NOT a misleading `edit_lock_not_held` (archive cleared the lock).
    const before = await draftVersionOf(capId);
    const err = await captureError(() =>
      updateAuthoredDraft(
        saveArgs(projectSlug, capId, before, {
          sessionId: "s1",
          userId: holder,
        }),
      ),
    );

    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("immutable");
    expect(err.details?.reason).toBeUndefined();
  });
});
