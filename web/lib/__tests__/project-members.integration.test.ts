import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;
const { projectMembers, projects, users } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let api: typeof import("@/lib/project-members");

const ACTOR = "usr_actor_admin";

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("members_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  api = await import("@/lib/project-members");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(projectMembers);
  await db.delete(projects);
  await db.delete(users);
});

async function seedProject(): Promise<string> {
  const id = randomUUID();

  await db.insert(projects).values({
    id,
    slug: `pm-${id.slice(0, 8)}`,
    name: `PM ${id.slice(0, 4)}`,
    repoPath: `/repos/pm-${id}`,
    maisterYamlPath: `/repos/pm-${id}/maister.yaml`,
  });

  return id;
}

async function seedUser(tag: string): Promise<string> {
  const id = randomUUID();

  await db.insert(users).values({
    id,
    name: `User ${tag}`,
    email: `${tag}-${id.slice(0, 8)}@example.com`,
    role: "member",
    accountStatus: "active",
  });

  return id;
}

describe("addProjectMember + listProjectMembers", () => {
  it("attaches an existing user and lists them with audit + identity fields", async () => {
    const projectId = await seedProject();
    const userId = await seedUser("attach");

    const { memberId } = await api.addProjectMember({
      projectId,
      userId,
      role: "member",
      actorId: ACTOR,
    });

    const members = await api.listProjectMembers(projectId);

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      memberId,
      userId,
      role: "member",
      addedBy: ACTOR,
    });
    expect(members[0].email).toContain("attach-");
  });

  it("is scoped per project", async () => {
    const projectA = await seedProject();
    const projectB = await seedProject();
    const userId = await seedUser("scope");

    await api.addProjectMember({
      projectId: projectA,
      userId,
      role: "member",
      actorId: ACTOR,
    });

    expect(await api.listProjectMembers(projectB)).toHaveLength(0);
  });

  it("rejects a duplicate membership with CONFLICT", async () => {
    const projectId = await seedProject();
    const userId = await seedUser("dup");

    await api.addProjectMember({
      projectId,
      userId,
      role: "member",
      actorId: ACTOR,
    });

    await expect(
      api.addProjectMember({
        projectId,
        userId,
        role: "admin",
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects adding a non-existent user with PRECONDITION", async () => {
    const projectId = await seedProject();

    await expect(
      api.addProjectMember({
        projectId,
        userId: randomUUID(),
        role: "member",
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

describe("changeProjectMemberRole", () => {
  it("changes role and stamps updated_by/updated_at", async () => {
    const projectId = await seedProject();
    const userId = await seedUser("role");
    const { memberId } = await api.addProjectMember({
      projectId,
      userId,
      role: "member",
      actorId: ACTOR,
    });

    await api.changeProjectMemberRole({
      projectId,
      memberId,
      role: "admin",
      actorId: "usr_other_admin",
    });

    const rows = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.id, memberId));

    expect(rows[0].role).toBe("admin");
    expect(rows[0].updatedBy).toBe("usr_other_admin");
    expect(rows[0].updatedAt).toBeInstanceOf(Date);
  });

  it("allows demoting an owner (no last-owner guard, D8)", async () => {
    const projectId = await seedProject();
    const userId = await seedUser("owner");
    const { memberId } = await api.addProjectMember({
      projectId,
      userId,
      role: "owner",
      actorId: ACTOR,
    });

    await api.changeProjectMemberRole({
      projectId,
      memberId,
      role: "viewer",
      actorId: ACTOR,
    });

    const rows = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.id, memberId));

    expect(rows[0].role).toBe("viewer");
  });

  it("rejects an unknown memberId with CONFLICT", async () => {
    const projectId = await seedProject();

    await expect(
      api.changeProjectMemberRole({
        projectId,
        memberId: randomUUID(),
        role: "admin",
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a memberId from another project with CONFLICT", async () => {
    const projectA = await seedProject();
    const projectB = await seedProject();
    const userId = await seedUser("xproj");
    const { memberId } = await api.addProjectMember({
      projectId: projectA,
      userId,
      role: "member",
      actorId: ACTOR,
    });

    await expect(
      api.changeProjectMemberRole({
        projectId: projectB,
        memberId,
        role: "admin",
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("removeProjectMember", () => {
  it("removes a member, including an owner (no last-owner guard, D8)", async () => {
    const projectId = await seedProject();
    const userId = await seedUser("rm-owner");
    const { memberId } = await api.addProjectMember({
      projectId,
      userId,
      role: "owner",
      actorId: ACTOR,
    });

    await api.removeProjectMember({ projectId, memberId, actorId: ACTOR });

    expect(await api.listProjectMembers(projectId)).toHaveLength(0);
  });

  it("rejects a second removal (already gone) with CONFLICT", async () => {
    const projectId = await seedProject();
    const userId = await seedUser("rm-twice");
    const { memberId } = await api.addProjectMember({
      projectId,
      userId,
      role: "member",
      actorId: ACTOR,
    });

    await api.removeProjectMember({ projectId, memberId, actorId: ACTOR });

    await expect(
      api.removeProjectMember({ projectId, memberId, actorId: ACTOR }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("searchMemberCandidates", () => {
  it("returns non-member users matching the query and excludes existing members", async () => {
    const projectId = await seedProject();
    const token = `cand${randomUUID().slice(0, 6)}`;
    const memberUser = await seedUser(token);
    const freeUser = await seedUser(token);

    await api.addProjectMember({
      projectId,
      userId: memberUser,
      role: "member",
      actorId: ACTOR,
    });

    const candidates = await api.searchMemberCandidates(projectId, token);

    expect(candidates.map((c) => c.id)).toContain(freeUser);
    expect(candidates.map((c) => c.id)).not.toContain(memberUser);
  });
});

describe("schema audit columns reachable", () => {
  it("stores added_by on insert", async () => {
    const projectId = await seedProject();
    const userId = await seedUser("audit");
    const { memberId } = await api.addProjectMember({
      projectId,
      userId,
      role: "member",
      actorId: ACTOR,
    });
    const rows = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.id, memberId),
          eq(projectMembers.projectId, projectId),
        ),
      );

    expect(rows[0].addedBy).toBe(ACTOR);
  });
});
