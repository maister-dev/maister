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
import { register } from "@/app/(auth)/actions";
import { verifyPassword } from "@/lib/password";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// Mock auth module to avoid Next.js session requirement in tests
vi.mock("@/auth", () => ({
  signIn: vi.fn(),
  auth: vi.fn(),
  handlers: {},
}));

// Mock getDb to use test container
vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("register_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("register action (integration)", () => {
  it("migration seeds exactly one bootstrap admin with must_change_password", async () => {
    const admins = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.role, "admin"));

    expect(admins).toHaveLength(1);
    expect(admins[0].email).toBe("admin@maister.local");
    expect(admins[0].mustChangePassword).toBe(true);
  });

  it("public registration never grants admin (always member)", async () => {
    const result = await register({
      name: "First User",
      email: "first@test.com",
      password: "SecurePassword123",
    });

    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "first@test.com"));

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("member");
    expect(rows[0].mustChangePassword).toBe(false);

    // The bootstrap admin remains the only admin.
    const admins = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.role, "admin"));

    expect(admins).toHaveLength(1);
  });

  it("second user becomes member", async () => {
    await register({
      name: "First User",
      email: "first2@test.com",
      password: "SecurePassword123",
    });

    const result = await register({
      name: "Second User",
      email: "second@test.com",
      password: "SecurePassword123",
    });

    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "second@test.com"));

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("member");
  });

  it("duplicate email returns error", async () => {
    await register({
      name: "User A",
      email: "dup@test.com",
      password: "SecurePassword123",
    });

    const result = await register({
      name: "User B",
      email: "dup@test.com",
      password: "SecurePassword123",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("duplicate");
    }
  });

  it("password less than 12 characters returns weak error", async () => {
    const result = await register({
      name: "Weak Password User",
      email: "weak@test.com",
      password: "Short1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("weak");
    }
  });

  it("invalid email returns invalid error", async () => {
    const result = await register({
      name: "Invalid Email User",
      email: "not-an-email",
      password: "SecurePassword123",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid");
    }
  });

  it("password is hashed and not stored as plaintext", async () => {
    const plainPassword = "SecurePassword123";

    await register({
      name: "Hashed Password User",
      email: "hashed@test.com",
      password: plainPassword,
    });

    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "hashed@test.com"));

    expect(rows).toHaveLength(1);
    const user = rows[0];

    expect(user.passwordHash).not.toBe(plainPassword);
    expect(user.passwordHash).toBeTruthy();

    const matches = await verifyPassword(plainPassword, user.passwordHash);

    expect(matches).toBe(true);
  });

  it("email is normalized to lowercase", async () => {
    const result = await register({
      name: "Uppercase Email User",
      email: "MixedCase@TEST.COM",
      password: "SecurePassword123",
    });

    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "mixedcase@test.com"));

    expect(rows).toHaveLength(1);
  });

  it("duplicate email with different casing returns duplicate error", async () => {
    await register({
      name: "User 1",
      email: "CaseSens@TEST.COM",
      password: "SecurePassword123",
    });

    const result = await register({
      name: "User 2",
      email: "casesens@test.com",
      password: "SecurePassword123",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("duplicate");
    }
  });

  it("user name is stored correctly", async () => {
    const testName = "Alice Wonder";

    await register({
      name: testName,
      email: "alice@test.com",
      password: "SecurePassword123",
    });

    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "alice@test.com"));

    expect(rows[0].name).toBe(testName);
  });

  it("multiple registrations with different emails all succeed", async () => {
    const result1 = await register({
      name: "User 1",
      email: "user1@test.com",
      password: "SecurePassword123",
    });

    const result2 = await register({
      name: "User 2",
      email: "user2@test.com",
      password: "SecurePassword123",
    });

    const result3 = await register({
      name: "User 3",
      email: "user3@test.com",
      password: "SecurePassword123",
    });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    expect(result3.ok).toBe(true);

    const allUsers = await db.select().from(schema.users);

    expect(allUsers.length).toBeGreaterThanOrEqual(3);
  });
});
