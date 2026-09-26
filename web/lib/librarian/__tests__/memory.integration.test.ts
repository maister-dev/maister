import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { librarianTurns } from "@/lib/db/schema";
import {
  editPersonalMemory,
  forgetPersonalMemory,
  listPersonalMemory,
  rememberFromLibrarianTurn,
  rememberPersonalMemory,
} from "@/lib/librarian/memory";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
  seedLibrarianTurn,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_memory",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-LMM-01/02/06/11: personal memory lifecycle", () => {
  it("stores an explicit owner-turn item, revisioned edit, and a forgotten tombstone", async () => {
    const db = database.db;
    const ownerId = await seedActiveUser(db);
    const turnId = await seedLibrarianTurn(db, ownerId);
    const itemId = await rememberFromLibrarianTurn(
      ownerId,
      turnId,
      {
        kind: "preference",
        content: "Prefer concise summaries",
        scope: "general",
      },
      async () => undefined,
      db as never,
    );
    const first = await listPersonalMemory(ownerId, db as never);

    expect(first.items).toMatchObject([
      { id: itemId, content: "Prefer concise summaries", revision: 1 },
    ]);
    const [brain] = (await db.execute(sql`
      SELECT count(*)::int AS count FROM brain_items
    `)).rows as Array<{ count: number }>;

    expect(brain.count).toBe(0);
    await editPersonalMemory(
      ownerId,
      itemId,
      {
        expectedRevision: 1,
        content: "Prefer brief summaries",
      },
      db as never,
    );
    const edited = await listPersonalMemory(ownerId, db as never);

    expect(edited.items[0]).toMatchObject({
      content: "Prefer brief summaries",
      revision: 2,
    });
    const original = await db.execute(
      sql`SELECT content FROM librarian_memory_items WHERE id = ${itemId}`,
    );

    expect((original.rows[0] as { content: string }).content).toBe(
      "Prefer concise summaries",
    );
    await forgetPersonalMemory(ownerId, itemId, db as never);
    expect((await listPersonalMemory(ownerId, db as never)).items).toHaveLength(
      0,
    );
    const tombstone = await db.execute(
      sql`SELECT content_digest FROM librarian_memory_tombstones WHERE user_id = ${ownerId}`,
    );

    expect(tombstone.rows).toHaveLength(2);
    const replacement = await rememberPersonalMemory(
      ownerId,
      {
        kind: "preference",
        content: "Prefer brief summaries",
        scope: "general",
      },
      db as never,
    );

    expect(replacement).not.toBe(itemId);
    expect((await listPersonalMemory(ownerId, db as never)).items).toHaveLength(
      1,
    );
    const [conversation] = (
      await db.execute(sql`
      SELECT forget_generation, context_epoch FROM librarian_conversations WHERE user_id = ${ownerId}
    `)
    ).rows as Array<{ forget_generation: number; context_epoch: number }>;

    expect(conversation.forget_generation).toBe(1);
    expect(conversation.context_epoch).toBe(1);
  });

  it("refuses an Explain turn and a stale owner-message generation", async () => {
    const db = database.db;
    const ownerId = await seedActiveUser(db);
    const turnId = await seedLibrarianTurn(db, ownerId);
    const draft = {
      kind: "fact",
      content: "Remember this",
      scope: "general",
    } as const;

    await db
      .update(librarianTurns)
      .set({ variant: "explain" })
      .where(eq(librarianTurns.id, turnId));
    await expect(
      rememberFromLibrarianTurn(
        ownerId,
        turnId,
        draft,
        async () => undefined,
        db as never,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await db
      .update(librarianTurns)
      .set({ variant: "owner_message" })
      .where(eq(librarianTurns.id, turnId));
    await db.execute(
      sql`UPDATE librarian_conversations SET context_epoch = context_epoch + 1 WHERE user_id = ${ownerId}`,
    );
    await expect(
      rememberFromLibrarianTurn(
        ownerId,
        turnId,
        draft,
        async () => undefined,
        db as never,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await listPersonalMemory(ownerId, db as never)).items).toHaveLength(
      0,
    );
  });

  it("hides project-sourced content after membership is removed", async () => {
    const db = database.db;
    const ownerId = await seedActiveUser(db);
    const project = await seedProjectRow(db);

    await addProjectMember(db, {
      projectId: project.id,
      userId: ownerId,
      role: "member",
    });
    const itemId = await rememberPersonalMemory(
      ownerId,
      {
        kind: "goal",
        content: "Project-only goal",
        scope: "project",
        projectSlug: project.slug,
      },
      db as never,
    );

    expect(
      (await listPersonalMemory(ownerId, db as never)).items[0]?.content,
    ).toBe("Project-only goal");
    await removeProjectMember(db, { projectId: project.id, userId: ownerId });
    expect(
      (await listPersonalMemory(ownerId, db as never)).items[0],
    ).toMatchObject({
      id: itemId,
      content: "",
      excludedReason: "source_unavailable",
    });
  });
});
