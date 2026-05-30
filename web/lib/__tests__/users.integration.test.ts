import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { verifyPassword } from "@/lib/password";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let usersApi: typeof import("@/lib/users");

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("users_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  usersApi = await import("@/lib/users");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function userByEmail(email: string): Promise<Record<string, any>> {
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email));

  expect(rows).toHaveLength(1);

  return rows[0];
}

describe("user lifecycle persistence (integration)", () => {
  it("migration marks the bootstrap admin active", async () => {
    const rows = await db.execute(
      sql`select account_status, must_change_password from users where email = 'admin@maister.local'`,
    );
    const row = rows.rows[0] as {
      account_status: string;
      must_change_password: boolean;
    };

    expect(row.account_status).toBe("active");
    expect(row.must_change_password).toBe(true);
  });

  it("public registration creates a pending member and stores a hashed password", async () => {
    const result = await usersApi.registerPendingUser({
      name: "Pending User",
      email: "Pending@TEST.COM",
      password: "SecurePassword123",
    });

    expect(result.status).toBe("pending");
    expect(result.email).toBe("pending@test.com");

    const row = await userByEmail("pending@test.com");

    expect(row.role).toBe("member");
    expect(row.accountStatus).toBe("pending");
    expect(row.mustChangePassword).toBe(false);
    expect(row.passwordHash).not.toBe("SecurePassword123");
    await expect(
      verifyPassword("SecurePassword123", row.passwordHash),
    ).resolves.toBe(true);
  });

  it("credential verification distinguishes pending and disabled accounts", async () => {
    await usersApi.registerPendingUser({
      name: "Lifecycle User",
      email: "lifecycle@test.com",
      password: "SecurePassword123",
    });

    await expect(
      usersApi.verifyCredentialAccount({
        email: "lifecycle@test.com",
        password: "SecurePassword123",
      }),
    ).resolves.toEqual({ ok: false, reason: "pending" });

    const row = await userByEmail("lifecycle@test.com");

    await usersApi.setUserStatus({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: row.id,
      status: "active",
    });

    await expect(
      usersApi.verifyCredentialAccount({
        email: "lifecycle@test.com",
        password: "SecurePassword123",
      }),
    ).resolves.toMatchObject({ ok: true });

    await usersApi.setUserStatus({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: row.id,
      status: "disabled",
    });

    await expect(
      usersApi.verifyCredentialAccount({
        email: "lifecycle@test.com",
        password: "SecurePassword123",
      }),
    ).resolves.toEqual({ ok: false, reason: "disabled" });
  });

  it("status transitions update metadata and support re-enable", async () => {
    const created = await usersApi.registerPendingUser({
      name: "Status Metadata",
      email: "status-metadata@test.com",
      password: "SecurePassword123",
    });

    await usersApi.setUserStatus({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      status: "active",
    });

    await usersApi.setUserStatus({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      status: "disabled",
    });

    await usersApi.setUserStatus({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      status: "active",
    });

    const row = await userByEmail("status-metadata@test.com");

    expect(row.accountStatus).toBe("active");
    expect(row.accountStatusUpdatedBy).toBe("usr_bootstrap_admin");
    expect(row.accountStatusUpdatedAt).toBeInstanceOf(Date);
  });
});

describe("admin user management invariants (integration)", () => {
  it("lists users without password hashes and supports status filtering", async () => {
    await usersApi.registerPendingUser({
      name: "List Pending",
      email: "list-pending@test.com",
      password: "SecurePassword123",
    });

    const rows = await usersApi.listAdminUsers({ status: "pending" });

    expect(rows.some((u) => u.email === "list-pending@test.com")).toBe(true);
    expect(rows.every((u) => !("passwordHash" in u))).toBe(true);
    expect(rows.every((u) => u.status === "pending")).toBe(true);
  });

  it("prevents self-disable and self-demotion", async () => {
    await expect(
      usersApi.setUserStatus({
        adminUserId: "usr_bootstrap_admin",
        targetUserId: "usr_bootstrap_admin",
        status: "disabled",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    await expect(
      usersApi.setUserRole({
        adminUserId: "usr_bootstrap_admin",
        targetUserId: "usr_bootstrap_admin",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("changes roles and prevents removing the last active admin", async () => {
    const created = await usersApi.registerPendingUser({
      name: "Role Target",
      email: "role-target@test.com",
      password: "SecurePassword123",
    });

    await usersApi.setUserStatus({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      status: "active",
    });

    await usersApi.setUserRole({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      role: "admin",
    });

    let row = await userByEmail("role-target@test.com");

    expect(row.role).toBe("admin");

    await usersApi.setUserRole({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      role: "member",
    });

    row = await userByEmail("role-target@test.com");

    expect(row.role).toBe("member");

    await expect(
      usersApi.setUserRole({
        adminUserId: created.id,
        targetUserId: "usr_bootstrap_admin",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("resets a user password and forces the next-login password gate", async () => {
    const created = await usersApi.registerPendingUser({
      name: "Reset Me",
      email: "reset-me@test.com",
      password: "SecurePassword123",
    });

    await usersApi.resetUserPassword({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      password: "TemporaryPassword123",
      mustChangePassword: true,
    });

    const row = await userByEmail("reset-me@test.com");

    expect(row.mustChangePassword).toBe(true);
    await expect(
      verifyPassword("TemporaryPassword123", row.passwordHash),
    ).resolves.toBe(true);
  });
});
