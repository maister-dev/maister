// `IT-NAV-06` (ADR-172 D6) — nav visibility is NOT the authorization boundary.
//
// The rail appends its admin tail only when `userRole === "admin"`. That is a
// convenience. This proves the claim the convenience rests on: a member asking
// for an admin destination is refused SERVER-SIDE, against the live `users`
// row, no matter what the rail rendered — and the refusal is re-decided on every
// request, so a demoted admin loses it immediately.
//
// `@/auth` is mocked both to control the session and to keep next-auth's beta
// ESM out of the Vitest module graph (the established pattern in
// `authz-db-authoritative.integration.test.ts`).

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

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

let requireGlobalRole: typeof import("@/lib/authz").requireGlobalRole;
let buildLeftRailSections: typeof import("@/components/chrome/left-rail-sections").buildLeftRailSections;

/** The rail's admin-only tail, and the global role each destination demands. */
const ADMIN_SECTIONS = [
  "agents",
  "mcps",
  "users",
  "scheduler",
  "settings",
] as const;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "nav_authz_test",
  });
  db = testDatabase.db;

  ({ requireGlobalRole } = await import("@/lib/authz"));
  ({ buildLeftRailSections } = await import(
    "@/components/chrome/left-rail-sections"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedUser(role: "admin" | "member" | "viewer"): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.users).values({
    id,
    email: `${id}@nav.test`,
    role,
    accountStatus: "active",
    passwordHash: "x",
  });

  return id;
}

function signIn(userId: string): void {
  sessionRef.value = { user: { id: userId } };
}

describe("IT-NAV-06 the rail hides, the server refuses", () => {
  it("refuses an admin destination to a member whose rail never offered it", async () => {
    const memberId = await seedUser("member");
    const rail = buildLeftRailSections((key) => key, "member");

    // Premise: the rail genuinely hid every admin section from this reader.
    for (const section of ADMIN_SECTIONS) {
      expect(
        rail.some((entry) => entry.id === section),
        section,
      ).toBe(false);
    }

    signIn(memberId);

    // And the server refuses regardless, which is the part that matters.
    await expect(requireGlobalRole("admin")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("refuses a viewer too, and still lets the admin through", async () => {
    signIn(await seedUser("viewer"));
    await expect(requireGlobalRole("admin")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    const adminId = await seedUser("admin");

    signIn(adminId);
    await expect(requireGlobalRole("admin")).resolves.toMatchObject({
      id: adminId,
      role: "admin",
    });
  });

  it("re-decides on the live row, so a demotion takes effect without a new rail", async () => {
    const userId = await seedUser("admin");

    signIn(userId);
    await expect(requireGlobalRole("admin")).resolves.toMatchObject({
      role: "admin",
    });

    // The rail this reader already has in their browser still shows the admin
    // tail. The next request is refused anyway.
    await db
      .update(schema.users)
      .set({ role: "member" })
      .where(eq(schema.users.id, userId));

    await expect(requireGlobalRole("admin")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    const staleRail = buildLeftRailSections((key) => key, "admin");

    expect(staleRail.some((entry) => entry.id === "users")).toBe(true);
  });

  it("refuses an unauthenticated request before it reaches a role check", async () => {
    sessionRef.value = null;
    await expect(requireGlobalRole("admin")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
