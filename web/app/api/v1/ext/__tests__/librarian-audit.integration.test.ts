import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import { LIBRARIAN_TOKEN_SCOPES } from "@/types/token-scopes";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-184: every librarian-token request is attributed to the human it acted
// for and the turn that issued it, and an audit that cannot be written fails
// the request with it.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

type TaskRoutes = typeof import("@/app/api/v1/ext/projects/[slug]/tasks/route");

let tasks: TaskRoutes;
let ownerId = "";
let project = { id: "", slug: "" };

function request(token: string, body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/test", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
  });
}

async function turnToken(turnId: string): Promise<string> {
  return (
    await issueLibrarianTurnToken(
      {
        ownerUserId: ownerId,
        turnId,
        scopes: LIBRARIAN_TOKEN_SCOPES,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
      db,
    )
  ).secret;
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_audit",
  });
  db = database.db as unknown as NodePgDatabase;
  ownerId = await seedActiveUser(db);
  project = await seedProjectRow(db);
  await addProjectMember(db, {
    projectId: project.id,
    userId: ownerId,
    role: "member",
  });
  tasks = await import("@/app/api/v1/ext/projects/[slug]/tasks/route");
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-LAU-07: librarian requests are attributed and fail closed on audit", () => {
  it("records the owner and the turn on the success audit of a task create", async () => {
    const turnId = randomUUID();
    const res = await tasks.POST(
      request(await turnToken(turnId), { title: "Attributed", prompt: "p" }),
      { params: Promise.resolve({ slug: project.slug }) },
    );

    expect(res.status).toBe(201);

    const rows = await db.execute(sql`
      SELECT actor_label, on_behalf_of_user_id, librarian_turn_id, result, scope_used
      FROM token_audit_log
      WHERE librarian_turn_id = ${turnId}
    `);

    expect((rows as unknown as { rows: unknown[] }).rows).toEqual([
      {
        actor_label: `librarian:${ownerId}`,
        on_behalf_of_user_id: ownerId,
        librarian_turn_id: turnId,
        result: "ok",
        scope_used: "tasks:create",
      },
    ]);
  });

  it("fails the request and leaves no task when the audit write fails", async () => {
    const turnId = randomUUID();
    const title = `unaudited-${turnId}`;

    await db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION refuse_librarian_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.librarian_turn_id = '${turnId}' AND NEW.result = 'ok' THEN
          RAISE EXCEPTION 'audit sink unavailable';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_librarian_audit BEFORE INSERT ON token_audit_log
        FOR EACH ROW EXECUTE FUNCTION refuse_librarian_audit();
    `),
    );

    try {
      await expect(
        tasks.POST(request(await turnToken(turnId), { title, prompt: "p" }), {
          params: Promise.resolve({ slug: project.slug }),
        }),
      ).rejects.toThrow(/audit sink unavailable/);
    } finally {
      await db.execute(
        sql.raw(`DROP TRIGGER refuse_librarian_audit ON token_audit_log`),
      );
    }

    const created = await db.execute(
      sql`SELECT id FROM tasks WHERE title = ${title}`,
    );

    expect((created as unknown as { rows: unknown[] }).rows).toEqual([]);
  });
});
