import { randomUUID } from "node:crypto";

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

async function activate(targetUserId: string): Promise<void> {
  await usersApi.updateAdminUser({
    adminUserId: "usr_bootstrap_admin",
    targetUserId,
    status: "active",
  });
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

    await activate(row.id);

    await expect(
      usersApi.verifyCredentialAccount({
        email: "lifecycle@test.com",
        password: "SecurePassword123",
      }),
    ).resolves.toMatchObject({ ok: true });

    await usersApi.updateAdminUser({
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

  it("stamps lastLoginAt only on a successful credential login", async () => {
    const created = await usersApi.registerPendingUser({
      name: "Last Login",
      email: "last-login@test.com",
      password: "SecurePassword123",
    });

    let row = await userByEmail("last-login@test.com");

    expect(row.lastLoginAt).toBeNull();

    // Pending → verification fails → no stamp.
    await usersApi.verifyCredentialAccount({
      email: "last-login@test.com",
      password: "SecurePassword123",
    });
    row = await userByEmail("last-login@test.com");
    expect(row.lastLoginAt).toBeNull();

    await activate(created.id);

    await usersApi.verifyCredentialAccount({
      email: "last-login@test.com",
      password: "SecurePassword123",
    });
    row = await userByEmail("last-login@test.com");
    expect(row.lastLoginAt).toBeInstanceOf(Date);
  });

  it("status transitions update metadata and support re-enable", async () => {
    const created = await usersApi.registerPendingUser({
      name: "Status Metadata",
      email: "status-metadata@test.com",
      password: "SecurePassword123",
    });

    await activate(created.id);

    await usersApi.updateAdminUser({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      status: "disabled",
    });

    await activate(created.id);

    const row = await userByEmail("status-metadata@test.com");

    expect(row.accountStatus).toBe("active");
    expect(row.accountStatusUpdatedBy).toBe("usr_bootstrap_admin");
    expect(row.accountStatusUpdatedAt).toBeInstanceOf(Date);
  });
});

describe("admin user management invariants (integration)", () => {
  it("lists users without password hashes and exposes lastLoginAt + projects", async () => {
    await usersApi.registerPendingUser({
      name: "List Pending",
      email: "list-pending@test.com",
      password: "SecurePassword123",
    });

    const rows = await usersApi.listAdminUsers({ status: "pending" });
    const listed = rows.find((u) => u.email === "list-pending@test.com");

    expect(listed).toBeDefined();
    expect(rows.every((u) => !("passwordHash" in u))).toBe(true);
    expect(rows.every((u) => u.status === "pending")).toBe(true);
    expect(listed).toHaveProperty("lastLoginAt");
    expect(listed?.projects).toEqual([]);
  });

  it("filters by global role", async () => {
    const rows = await usersApi.listAdminUsers({ role: "admin" });

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((u) => u.role === "admin")).toBe(true);
    expect(rows.some((u) => u.email === "admin@maister.local")).toBe(true);
  });

  it("filters by explicit project membership and returns per-user projects", async () => {
    const created = await usersApi.registerPendingUser({
      name: "Project Member",
      email: "proj-member@test.com",
      password: "SecurePassword123",
    });

    await activate(created.id);

    const projectId = "prj_filter_test";

    await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: "filter-test",
      name: "Filter Test",
      repoPath: "/tmp/filter-test",
      maisterYamlPath: "/tmp/filter-test/maister.yaml",
    });
    await db.insert(schema.projectMembers).values({
      projectId,
      userId: created.id,
      role: "member",
    });

    const rows = await usersApi.listAdminUsers({ projectId });

    expect(rows.map((u) => u.email)).toEqual(["proj-member@test.com"]);
    // Global admins are NOT implicit matches of a per-project filter.
    expect(rows.some((u) => u.email === "admin@maister.local")).toBe(false);
    expect(rows[0].projects).toEqual([
      {
        id: projectId,
        slug: "filter-test",
        name: "Filter Test",
        role: "member",
      },
    ]);
  });

  it("prevents self-disable and self-demotion", async () => {
    await expect(
      usersApi.updateAdminUser({
        adminUserId: "usr_bootstrap_admin",
        targetUserId: "usr_bootstrap_admin",
        status: "disabled",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    await expect(
      usersApi.updateAdminUser({
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

    await activate(created.id);

    await usersApi.updateAdminUser({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      role: "admin",
    });

    let row = await userByEmail("role-target@test.com");

    expect(row.role).toBe("admin");

    await usersApi.updateAdminUser({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      role: "member",
    });

    row = await userByEmail("role-target@test.com");

    expect(row.role).toBe("member");

    await expect(
      usersApi.updateAdminUser({
        adminUserId: created.id,
        targetUserId: "usr_bootstrap_admin",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("applies role + status + password in a single call", async () => {
    const created = await usersApi.registerPendingUser({
      name: "Combined Edit",
      email: "combined@test.com",
      password: "SecurePassword123",
    });

    await usersApi.updateAdminUser({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: created.id,
      role: "viewer",
      status: "active",
      password: "TemporaryPassword123",
      mustChangePassword: true,
    });

    const row = await userByEmail("combined@test.com");

    expect(row.role).toBe("viewer");
    expect(row.accountStatus).toBe("active");
    expect(row.mustChangePassword).toBe(true);
    await expect(
      verifyPassword("TemporaryPassword123", row.passwordHash),
    ).resolves.toBe(true);
  });
});

describe("createAdminUser (integration)", () => {
  it("creates an active user with a supplied password, stamps created_by, forces change", async () => {
    const res = await usersApi.createAdminUser({
      adminUserId: "usr_bootstrap_admin",
      name: "Ada Create",
      email: "Ada.Create@Example.com",
      role: "member",
      status: "active",
      password: "supplied-pass-123",
    });

    expect(res.tempPassword).toBe("supplied-pass-123");

    const row = await userByEmail("ada.create@example.com");

    expect(row.id).toBe(res.id);
    expect(row.role).toBe("member");
    expect(row.accountStatus).toBe("active");
    expect(row.mustChangePassword).toBe(true);
    expect(row.createdBy).toBe("usr_bootstrap_admin");
    await expect(
      verifyPassword("supplied-pass-123", row.passwordHash),
    ).resolves.toBe(true);
  });

  it("auto-generates a >=12 char temp password that verifies when none supplied", async () => {
    const res = await usersApi.createAdminUser({
      adminUserId: "usr_bootstrap_admin",
      name: "Gen Create",
      email: "gen.create@example.com",
      role: "viewer",
      status: "pending",
    });

    expect(res.tempPassword.length).toBeGreaterThanOrEqual(12);

    const row = await userByEmail("gen.create@example.com");

    expect(row.accountStatus).toBe("pending");
    await expect(
      verifyPassword(res.tempPassword, row.passwordHash),
    ).resolves.toBe(true);
  });

  it("rejects a duplicate email (case-insensitive) with CONFLICT", async () => {
    await usersApi.createAdminUser({
      adminUserId: "usr_bootstrap_admin",
      name: "Dup One",
      email: "dup.create@example.com",
      role: "member",
      status: "active",
      password: "first-pass-1234",
    });

    await expect(
      usersApi.createAdminUser({
        adminUserId: "usr_bootstrap_admin",
        name: "Dup Two",
        email: "DUP.CREATE@example.com",
        role: "member",
        status: "active",
        password: "second-pass-123",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("updateAdminUser identity edits (integration)", () => {
  it("edits name and email (lowercased) and stamps updated_by/updated_at", async () => {
    const { id } = await usersApi.createAdminUser({
      adminUserId: "usr_bootstrap_admin",
      name: "Old Identity",
      email: "old.identity@example.com",
      role: "member",
      status: "active",
      password: "init-pass-12345",
    });

    await usersApi.updateAdminUser({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: id,
      name: "New Identity",
      email: "New.Identity@Example.com",
    });

    const row = await userByEmail("new.identity@example.com");

    expect(row.id).toBe(id);
    expect(row.name).toBe("New Identity");
    expect(row.updatedBy).toBe("usr_bootstrap_admin");
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects an email edit colliding with another user (CONFLICT)", async () => {
    await usersApi.createAdminUser({
      adminUserId: "usr_bootstrap_admin",
      name: "Taken",
      email: "taken.identity@example.com",
      role: "member",
      status: "active",
      password: "init-pass-12345",
    });
    const { id } = await usersApi.createAdminUser({
      adminUserId: "usr_bootstrap_admin",
      name: "Free",
      email: "free.identity@example.com",
      role: "member",
      status: "active",
      password: "init-pass-67890",
    });

    await expect(
      usersApi.updateAdminUser({
        adminUserId: "usr_bootstrap_admin",
        targetUserId: id,
        email: "TAKEN.IDENTITY@example.com",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("hardDeleteAdminUser (integration)", () => {
  async function seedPendingUnused(): Promise<string> {
    const { id } = await usersApi.createAdminUser({
      adminUserId: "usr_bootstrap_admin",
      name: "Pending Unused",
      email: `pend-${randomUUID().slice(0, 8)}@example.com`,
      role: "member",
      status: "pending",
    });

    return id;
  }

  async function seedProject(): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id,
      slug: `hd-${id.slice(0, 8)}`,
      name: `HardDelete ${id.slice(0, 4)}`,
      repoPath: `/repos/hd-${id}`,
      maisterYamlPath: `/repos/hd-${id}/maister.yaml`,
    });

    return id;
  }

  it("deletes an unused pending user and cascades project_members", async () => {
    const id = await seedPendingUnused();
    const projectId = await seedProject();

    await db.insert(schema.projectMembers).values({
      id: randomUUID(),
      projectId,
      userId: id,
      role: "member",
    });

    await usersApi.hardDeleteAdminUser({
      adminUserId: "usr_bootstrap_admin",
      targetUserId: id,
    });

    const gone = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id));

    expect(gone).toHaveLength(0);

    const members = await db
      .select()
      .from(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, id));

    expect(members).toHaveLength(0);
  });

  it("refuses with PRECONDITION when the user is referenced by content", async () => {
    const id = await seedPendingUnused();
    const projectId = await seedProject();

    await db.insert(schema.actorIdentities).values({
      id: randomUUID(),
      projectId,
      kind: "user",
      label: "ref",
      userId: id,
    });

    await expect(
      usersApi.hardDeleteAdminUser({
        adminUserId: "usr_bootstrap_admin",
        targetUserId: id,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    const still = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id));

    expect(still).toHaveLength(1);
  });

  it("refuses with PRECONDITION when the user owns a personal token", async () => {
    const id = await seedPendingUnused();
    const projectId = await seedProject();

    await db.insert(schema.projectTokens).values({
      id: randomUUID(),
      project_id: projectId,
      name: "Pending personal token",
      token_kind: "user",
      owner_user_id: id,
      prefix: "mai_pending",
      token_hash: "sha256-placeholder",
      scopes: ["tasks:create"],
    });

    await expect(
      usersApi.hardDeleteAdminUser({
        adminUserId: "usr_bootstrap_admin",
        targetUserId: id,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("refuses with PRECONDITION when the account is not pending", async () => {
    const { id } = await usersApi.createAdminUser({
      adminUserId: "usr_bootstrap_admin",
      name: "Active NoDelete",
      email: "active.nodelete@example.com",
      role: "member",
      status: "active",
      password: "init-pass-12345",
    });

    await expect(
      usersApi.hardDeleteAdminUser({
        adminUserId: "usr_bootstrap_admin",
        targetUserId: id,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("refuses with PRECONDITION when the user has logged in", async () => {
    const id = await seedPendingUnused();

    await db
      .update(schema.users)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.users.id, id));

    await expect(
      usersApi.hardDeleteAdminUser({
        adminUserId: "usr_bootstrap_admin",
        targetUserId: id,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("refuses self-delete with PRECONDITION", async () => {
    const id = await seedPendingUnused();

    await expect(
      usersApi.hardDeleteAdminUser({ adminUserId: id, targetUserId: id }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

describe("listAdminUsers + countAdminUsers pagination (integration)", () => {
  it("paginates with limit/offset and counts the filtered set", async () => {
    const token = `pg${randomUUID().slice(0, 8)}`;

    for (let i = 0; i < 5; i++) {
      await usersApi.createAdminUser({
        adminUserId: "usr_bootstrap_admin",
        name: `Pager ${token} ${i}`,
        email: `${token}-${i}@example.com`,
        role: i === 0 ? "admin" : "member",
        status: "active",
        password: `pw-${i}-abcdefgh`,
      });
    }

    expect(await usersApi.countAdminUsers({ q: token })).toBe(5);
    expect(await usersApi.countAdminUsers({ q: token, role: "admin" })).toBe(1);

    const page1 = await usersApi.listAdminUsers({
      q: token,
      limit: 2,
      offset: 0,
    });
    const page2 = await usersApi.listAdminUsers({
      q: token,
      limit: 2,
      offset: 2,
    });
    const page3 = await usersApi.listAdminUsers({
      q: token,
      limit: 2,
      offset: 4,
    });

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page3).toHaveLength(1);

    const ids = new Set([...page1, ...page2, ...page3].map((u) => u.id));

    expect(ids.size).toBe(5);
    expect(page1.every((u) => !("passwordHash" in u))).toBe(true);
  });
});
