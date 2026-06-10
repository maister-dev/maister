// Two-racer concurrency contract for POST /api/admin/acp-runners against a real
// testcontainer postgres. Proves the id-conflict path is race-safe: two
// simultaneous creates with the same id MUST resolve to exactly one 201 + one
// 409 (the typed CONFLICT) and NEVER a raw 23505 -> 500. A fake-DB unit test
// cannot exercise this — the unique constraint is the only race arbiter.
// Docker-only (skipped where the daemon is absent), like the other
// *.integration.test.ts suites.
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { type NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;
const { platformAcpRunners } = schema;

// requireGlobalRole is mocked to the seeded bootstrap admin (avoids the
// @/auth -> next-auth module graph); the DB itself is the real container.
vi.mock("@/lib/authz", () => ({
  requireGlobalRole: vi.fn(async () => ({
    id: "usr_bootstrap_admin",
    role: "admin",
    mustChangePassword: false,
  })),
}));

// No live supervisor in the test; readiness is derived from null diagnostics.
vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorDiagnostics: vi.fn(async () => ({ kind: "unavailable" })),
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("acp_runner_race_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Must be set before the route's first getDb() (it caches the pool).
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  process.env.DB_URL = originalDbUrl;
  // The route under test built the app's CACHED pool against this container
  // (getDb() via DB_URL above) — drain it before the container dies, or its
  // idle connections surface pg 57P01 as vitest unhandled errors.
  await closeDb();
  await pool?.end();
  await container?.stop();
});

function postRequest(body: unknown): NextRequest {
  return new Request("http://x/api/admin/acp-runners", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("POST /api/admin/acp-runners — concurrency (real postgres)", () => {
  it("two concurrent creates of the same id resolve to exactly one 201 + one 409, never 500", async () => {
    const { POST } = await import("../route");
    const body = {
      id: `race-${randomUUID().slice(0, 8)}`,
      adapter: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
    };

    const [r1, r2] = await Promise.all([
      POST(postRequest(body)),
      POST(postRequest(body)),
    ]);

    const statuses = [r1.status, r2.status].sort();

    expect(statuses).toEqual([201, 409]);
    // The loser must be the typed CONFLICT, not a raw unique-violation 500.
    const conflict = r1.status === 409 ? r1 : r2;
    const conflictBody = (await conflict.json()) as { code?: string };

    expect(conflictBody.code).toBe("CONFLICT");

    // Exactly one row persisted.
    const rows = await db
      .select()
      .from(platformAcpRunners)
      .where(eq(platformAcpRunners.id, body.id));

    expect(rows).toHaveLength(1);
  });
});
