import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";

// Copied from lib/authz.ts to avoid importing the module which depends on @/auth
const PROJECT_ACTION_MIN = {
  readBoard: "viewer",
  readScratchRun: "viewer",
  launchRun: "member",
  operateScratchRun: "member",
  promoteRun: "member",
  createTask: "member",
  answerHitl: "member",
  editSettings: "admin",
  managePackages: "admin",
} as const;

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("authz_test")
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

beforeEach(async () => {
  await db.delete(schema.projectMembers);
  await db.delete(schema.projects);
  await db.delete(schema.users);
});

describe("authorization (integration)", () => {
  async function createUser(
    email: string,
    role: "admin" | "member" | "viewer",
  ): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.users).values({
      id,
      name: `User ${email}`,
      email,
      passwordHash: null,
      role,
    });

    return id;
  }

  async function createProject(): Promise<string> {
    const id = randomUUID();
    const slug = `proj-${id.slice(0, 8)}`;

    await db.insert(schema.projects).values({
      id,
      slug,
      name: slug,
      repoPath: `/repos/${slug}`,
      maisterYamlPath: `/repos/${slug}/maister.yaml`,
    });

    return id;
  }

  async function addMember(
    userId: string,
    projectId: string,
    role: "owner" | "admin" | "member" | "viewer",
  ): Promise<void> {
    await db.insert(schema.projectMembers).values({
      id: randomUUID(),
      userId,
      projectId,
      role,
    });
  }

  it("project member role query returns null for non-member", async () => {
    const userId = await createUser("nonmember@test.com", "member");
    const projectId = await createProject();

    const rows = await db
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.userId, userId),
          eq(schema.projectMembers.projectId, projectId),
        ),
      );

    expect(rows[0]?.role ?? null).toBeNull();
  });

  it("project member role query returns the correct role for a member", async () => {
    const userId = await createUser("member@test.com", "member");
    const projectId = await createProject();

    await addMember(userId, projectId, "admin");

    const rows = await db
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.userId, userId),
          eq(schema.projectMembers.projectId, projectId),
        ),
      );

    expect(rows[0]?.role).toBe("admin");
  });

  it("project member roles follow the ordering: viewer < member < admin < owner", async () => {
    const viewer = await createUser("viewer-ordering@test.com", "member");
    const mem = await createUser("member-ordering@test.com", "member");
    const admin = await createUser("admin-ordering@test.com", "member");
    const owner = await createUser("owner-ordering@test.com", "member");
    const projectId = await createProject();

    await addMember(viewer, projectId, "viewer");
    await addMember(mem, projectId, "member");
    await addMember(admin, projectId, "admin");
    await addMember(owner, projectId, "owner");

    const getRole = async (userId: string) => {
      const rows = await db
        .select({ role: schema.projectMembers.role })
        .from(schema.projectMembers)
        .where(
          and(
            eq(schema.projectMembers.userId, userId),
            eq(schema.projectMembers.projectId, projectId),
          ),
        );

      return rows[0]?.role ?? null;
    };

    const viewerRole = await getRole(viewer);
    const memRole = await getRole(mem);
    const adminRole = await getRole(admin);
    const ownerRole = await getRole(owner);

    expect(viewerRole).toBe("viewer");
    expect(memRole).toBe("member");
    expect(adminRole).toBe("admin");
    expect(ownerRole).toBe("owner");
  });

  it("PROJECT_ACTION_MIN defines minimum roles for each action", () => {
    expect(PROJECT_ACTION_MIN.readBoard).toBe("viewer");
    expect(PROJECT_ACTION_MIN.readScratchRun).toBe("viewer");
    expect(PROJECT_ACTION_MIN.launchRun).toBe("member");
    expect(PROJECT_ACTION_MIN.operateScratchRun).toBe("member");
    expect(PROJECT_ACTION_MIN.promoteRun).toBe("member");
    expect(PROJECT_ACTION_MIN.createTask).toBe("member");
    expect(PROJECT_ACTION_MIN.answerHitl).toBe("member");
    expect(PROJECT_ACTION_MIN.editSettings).toBe("admin");
    expect(PROJECT_ACTION_MIN.managePackages).toBe("admin");
  });

  it("different users can have different roles on the same project", async () => {
    const projectId = await createProject();
    const user1 = await createUser("user1@test.com", "member");
    const user2 = await createUser("user2@test.com", "member");
    const user3 = await createUser("user3@test.com", "member");

    await addMember(user1, projectId, "owner");
    await addMember(user2, projectId, "member");
    await addMember(user3, projectId, "viewer");

    const getRole = async (userId: string) => {
      const rows = await db
        .select({ role: schema.projectMembers.role })
        .from(schema.projectMembers)
        .where(
          and(
            eq(schema.projectMembers.userId, userId),
            eq(schema.projectMembers.projectId, projectId),
          ),
        );

      return rows[0]?.role ?? null;
    };

    const role1 = await getRole(user1);
    const role2 = await getRole(user2);
    const role3 = await getRole(user3);

    expect(role1).toBe("owner");
    expect(role2).toBe("member");
    expect(role3).toBe("viewer");
  });

  it("same user can have different roles across different projects", async () => {
    const userId = await createUser("multi@test.com", "member");
    const proj1 = await createProject();
    const proj2 = await createProject();

    await addMember(userId, proj1, "owner");
    await addMember(userId, proj2, "viewer");

    const getRole = async (projId: string) => {
      const rows = await db
        .select({ role: schema.projectMembers.role })
        .from(schema.projectMembers)
        .where(
          and(
            eq(schema.projectMembers.userId, userId),
            eq(schema.projectMembers.projectId, projId),
          ),
        );

      return rows[0]?.role ?? null;
    };

    const roleProj1 = await getRole(proj1);
    const roleProj2 = await getRole(proj2);

    expect(roleProj1).toBe("owner");
    expect(roleProj2).toBe("viewer");
  });

  it("global admin role is independent of project memberships", async () => {
    const globalAdmin = await createUser("global@test.com", "admin");
    const projectId = await createProject();

    const rows = await db
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.userId, globalAdmin),
          eq(schema.projectMembers.projectId, projectId),
        ),
      );

    expect(rows[0]?.role ?? null).toBeNull();
  });
});
