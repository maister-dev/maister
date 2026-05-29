import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// Controllable session. Mocking @/auth also stops next-auth from being pulled
// into the Vitest module graph (its beta ESM trips the resolver).
const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

// Imported after mocks are registered.
let getSessionUser: typeof import("@/lib/authz").getSessionUser;
let requireGlobalRole: typeof import("@/lib/authz").requireGlobalRole;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("authz_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getSessionUser, requireGlobalRole } = await import("@/lib/authz"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedUser(
  id: string,
  role: "admin" | "member" | "viewer",
): Promise<void> {
  await db.insert(schema.users).values({
    id,
    email: `${id}@test.com`,
    role,
    passwordHash: "x",
  });
}

describe("authz is DB-authoritative on role (integration)", () => {
  it("uses the live DB role, not the cached session role", async () => {
    await seedUser("u-demoted", "member");
    // Session still claims admin (e.g. a JWT minted before demotion).
    sessionRef.value = { user: { id: "u-demoted", role: "admin" } };

    const resolved = await getSessionUser();

    expect(resolved?.role).toBe("member");
  });

  it("denies a privileged action when the DB role was lowered", async () => {
    await seedUser("u-was-admin", "member");
    sessionRef.value = { user: { id: "u-was-admin", role: "admin" } };

    await expect(requireGlobalRole("admin")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("invalidates the session when the user no longer exists", async () => {
    sessionRef.value = { user: { id: "u-deleted", role: "admin" } };

    const resolved = await getSessionUser();

    expect(resolved).toBeNull();
  });

  it("surfaces must_change_password from the DB", async () => {
    await seedUser("u-mcp", "member");
    await db
      .update(schema.users)
      .set({ mustChangePassword: true })
      .where(eq(schema.users.id, "u-mcp"));
    sessionRef.value = { user: { id: "u-mcp", role: "member" } };

    const resolved = await getSessionUser();

    expect(resolved?.mustChangePassword).toBe(true);
  });
});

describe("must_change_password fails closed on role-gated APIs (integration)", () => {
  it("rejects a must-change user with PASSWORD_CHANGE_REQUIRED, then allows after clearing", async () => {
    await seedUser("u-forced", "admin");
    await db
      .update(schema.users)
      .set({ mustChangePassword: true })
      .where(eq(schema.users.id, "u-forced"));
    sessionRef.value = { user: { id: "u-forced", role: "admin" } };

    // Every protected API funnels through requireGlobalRole / requireProjectRole
    // → requireActiveSession, so a forced-change account is blocked everywhere.
    await expect(requireGlobalRole("member")).rejects.toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
    });

    await db
      .update(schema.users)
      .set({ mustChangePassword: false })
      .where(eq(schema.users.id, "u-forced"));

    await expect(requireGlobalRole("admin")).resolves.toMatchObject({
      id: "u-forced",
      role: "admin",
    });
  });
});
