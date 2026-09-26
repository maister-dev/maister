import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

// Seeds for librarian suites. Raw SQL naming only the columns set here, so a
// suite replaying a partial migration point is not bound to the current shape.

export async function seedActiveUser(
  db: NodePgDatabase,
  input: { role?: "admin" | "member" | "viewer" } = {},
): Promise<string> {
  const id = randomUUID();

  await db.execute(sql`
    INSERT INTO "users" ("id", "email", "role", "account_status")
    VALUES (${id}, ${`${id}@example.test`}, ${input.role ?? "member"}, 'active')
  `);

  return id;
}

export async function addProjectMember(
  db: NodePgDatabase,
  input: {
    projectId: string;
    userId: string;
    role: "viewer" | "member" | "admin" | "owner";
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO "project_members" ("id", "project_id", "user_id", "role")
    VALUES (${randomUUID()}, ${input.projectId}, ${input.userId}, ${input.role})
  `);
}

export async function removeProjectMember(
  db: NodePgDatabase,
  input: { projectId: string; userId: string },
): Promise<void> {
  await db.execute(sql`
    DELETE FROM "project_members"
    WHERE "project_id" = ${input.projectId} AND "user_id" = ${input.userId}
  `);
}

// A turn id a librarian token can be bound to. Returns a fresh id; suites that
// need the durable turn row seed it through the conversation service.
export function librarianTurnIdForToken(): string {
  return randomUUID();
}
