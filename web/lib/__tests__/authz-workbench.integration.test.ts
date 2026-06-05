import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash.
const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// Controllable session. Mocking @/auth also stops next-auth from being pulled
// into the Vitest module graph (its beta ESM trips the resolver). Mirrors
// authz-db-authoritative.integration.test.ts.
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
let requireProjectAction: typeof import("@/lib/authz").requireProjectAction;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("authz_workbench_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ requireProjectAction } = await import("@/lib/authz"));
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
    accountStatus: "active",
    passwordHash: "x",
  });
}

async function seedProject(id: string): Promise<void> {
  await db.insert(schema.projects).values({
    id,
    slug: id,
    name: id,
    repoPath: `/tmp/${id}`,
    maisterYamlPath: `/tmp/${id}/maister.yaml`,
  });
}

async function seedMembership(
  userId: string,
  projectId: string,
  role: "owner" | "admin" | "member" | "viewer",
): Promise<void> {
  await db.insert(schema.projectMembers).values({
    id: `${userId}-${projectId}`,
    userId,
    projectId,
    role,
  });
}

describe("workbench project actions (integration)", () => {
  it("denies a viewer the readRepoFiles action", async () => {
    await seedUser("wb-rrf-viewer", "member");
    await seedProject("wb-rrf-view");
    await seedMembership("wb-rrf-viewer", "wb-rrf-view", "viewer");
    sessionRef.value = { user: { id: "wb-rrf-viewer", role: "member" } };

    await expect(
      requireProjectAction("wb-rrf-view", "readRepoFiles"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("admits a member to the readRepoFiles action", async () => {
    await seedUser("wb-rrf-member", "member");
    await seedProject("wb-rrf-member-proj");
    await seedMembership("wb-rrf-member", "wb-rrf-member-proj", "member");
    sessionRef.value = { user: { id: "wb-rrf-member", role: "member" } };

    await expect(
      requireProjectAction("wb-rrf-member-proj", "readRepoFiles"),
    ).resolves.toMatchObject({ role: "member" });
  });

  it("denies a viewer the editFlowLayout action", async () => {
    await seedUser("wb-efl-viewer", "member");
    await seedProject("wb-efl-view");
    await seedMembership("wb-efl-viewer", "wb-efl-view", "viewer");
    sessionRef.value = { user: { id: "wb-efl-viewer", role: "member" } };

    await expect(
      requireProjectAction("wb-efl-view", "editFlowLayout"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("admits a member to the editFlowLayout action", async () => {
    await seedUser("wb-efl-member", "member");
    await seedProject("wb-efl-member-proj");
    await seedMembership("wb-efl-member", "wb-efl-member-proj", "member");
    sessionRef.value = { user: { id: "wb-efl-member", role: "member" } };

    await expect(
      requireProjectAction("wb-efl-member-proj", "editFlowLayout"),
    ).resolves.toMatchObject({ role: "member" });
  });
});
