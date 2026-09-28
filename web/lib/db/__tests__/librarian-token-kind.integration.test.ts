import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { users } from "@/lib/db/schema";
import { seedProject } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-186 / migration 0183: the librarian token kind is owner-bound,
// project-less, agent-less, turn-bound and always expiring — enforced by the
// database, not only by the issuer.

let database: StartedPostgresTestDb;
let db: Db;
let ownerId: string;
let projectId: string;

type PgErrorLike = { constraint?: string; cause?: { constraint?: string } };

function constraintOf(err: unknown): string | undefined {
  const e = err as PgErrorLike;

  return e?.constraint ?? e?.cause?.constraint;
}

async function insertToken(fields: {
  tokenKind: string;
  projectId?: string | null;
  ownerUserId?: string | null;
  librarianTurnId?: string | null;
  expiresAt?: Date | null;
}): Promise<unknown> {
  try {
    await db.execute(sql`
      INSERT INTO project_tokens
        (id, project_id, name, token_kind, owner_user_id, librarian_turn_id,
         prefix, token_hash, scopes, expires_at)
      VALUES
        (${randomUUID()}, ${fields.projectId ?? null}, ${"librarian-turn:test"},
         ${fields.tokenKind}, ${fields.ownerUserId ?? null},
         ${fields.librarianTurnId ?? null}, ${"mst_test"}, ${"hash"},
         ${JSON.stringify(["tasks:read"])}::jsonb, ${fields.expiresAt ?? null})
    `);

    return null;
  } catch (err) {
    return err;
  }
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_token_kind",
  });
  db = database.db as unknown as Db;
  ownerId = randomUUID();
  await db.insert(users).values({
    id: ownerId,
    email: `${ownerId}@example.test`,
    accountStatus: "active",
  });
  projectId = await seedProject(database.db);
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-LAU-02 part 1: the librarian token shape is a database invariant", () => {
  const expiresAt = new Date(Date.now() + 60_000);

  it("refuses a librarian token that names a project", async () => {
    const err = await insertToken({
      tokenKind: "librarian",
      projectId,
      ownerUserId: ownerId,
      librarianTurnId: randomUUID(),
      expiresAt,
    });

    expect(constraintOf(err)).toBe("project_tokens_librarian_check");
  });

  it("refuses a librarian token without a turn binding", async () => {
    const err = await insertToken({
      tokenKind: "librarian",
      ownerUserId: ownerId,
      librarianTurnId: null,
      expiresAt,
    });

    expect(constraintOf(err)).toBe("project_tokens_librarian_check");
  });

  it("refuses a librarian token with no owner or no expiry", async () => {
    const noOwner = await insertToken({
      tokenKind: "librarian",
      librarianTurnId: randomUUID(),
      expiresAt,
    });
    const noExpiry = await insertToken({
      tokenKind: "librarian",
      ownerUserId: ownerId,
      librarianTurnId: randomUUID(),
      expiresAt: null,
    });

    expect(constraintOf(noOwner)).toBe("project_tokens_librarian_check");
    expect(constraintOf(noExpiry)).toBe("project_tokens_librarian_check");
  });

  it("refuses an unknown token kind", async () => {
    const err = await insertToken({
      tokenKind: "service",
      ownerUserId: ownerId,
    });

    expect(constraintOf(err)).toBe("project_tokens_kind_check");
  });

  it("stores the audit attribution columns on token_audit_log", async () => {
    const columns = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'token_audit_log'
        AND column_name IN ('on_behalf_of_user_id', 'librarian_turn_id', 'operation_id')
      ORDER BY column_name
    `);

    expect(
      (columns as unknown as { rows: { column_name: string }[] }).rows.map(
        (row) => row.column_name,
      ),
    ).toEqual(["librarian_turn_id", "on_behalf_of_user_id", "operation_id"]);
  });
});
