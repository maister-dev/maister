// ADR-078 D2 — task_key at registration: derived default, explicit override,
// and collision refusal (explicit OR derived) with CONFLICT. Exercises the
// REAL POST /api/projects handler against tmp dirs + minimal maister.yaml.

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let POST: typeof import("@/app/api/projects/route").POST;

const tmpRoot = mkdtempSync(path.join(tmpdir(), "taskkey-reg-"));

function projectDir(name: string): string {
  const dir = path.join(tmpRoot, `${randomUUID().slice(0, 8)}`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "maister.yaml"),
    `schemaVersion: 2\nproject:\n  name: ${name}\nflows: []\n`,
  );

  return dir;
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("taskkey_reg_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  const adminId = randomUUID();

  await db.insert(schema.users).values({
    id: adminId,
    email: `admin-${adminId.slice(0, 8)}@example.test`,
    role: "admin",
    accountStatus: "active",
  });
  sessionRef.value = { user: { id: adminId } };

  POST = (await import("@/app/api/projects/route")).POST;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("POST /api/projects task_key (ADR-078 D2)", () => {
  it("derives the key from the project name when no explicit key is given", async () => {
    const res = await POST(
      postRequest({ target: projectDir("Quebec Social") }),
    );

    expect(res.status).toBe(201);

    const body = (await res.json()) as { projectId: string };
    const rows = await pool.query(
      `select task_key, next_task_number from projects where id = $1`,
      [body.projectId],
    );

    expect(rows.rows[0]).toEqual({ task_key: "QUE", next_task_number: 1 });
  });

  it("uses the explicit body taskKey when provided", async () => {
    const res = await POST(
      postRequest({ target: projectDir("Whatever Name"), taskKey: "ZULU9" }),
    );

    expect(res.status).toBe(201);

    const body = (await res.json()) as { projectId: string };
    const rows = await pool.query(
      `select task_key from projects where id = $1`,
      [body.projectId],
    );

    expect(rows.rows[0].task_key).toBe("ZULU9");
  });

  it("refuses an explicit key collision with CONFLICT and persists nothing", async () => {
    const first = await POST(
      postRequest({ target: projectDir("Xray One"), taskKey: "XCOL" }),
    );

    expect(first.status).toBe(201);

    const dir = projectDir("Xray Two");
    const second = await POST(postRequest({ target: dir, taskKey: "XCOL" }));

    expect(second.status).toBe(409);

    const body = (await second.json()) as { code: string; message: string };

    expect(body.code).toBe("CONFLICT");
    expect(body.message).toContain('task key "XCOL"');

    const leftover = await pool.query(
      `select count(*)::int as c from projects where repo_path = $1`,
      [dir],
    );

    expect(leftover.rows[0].c).toBe(0);
  });

  it("refuses a DERIVED key collision with CONFLICT (no auto-uniquify at registration)", async () => {
    const first = await POST(postRequest({ target: projectDir("Yankee Alpha") }));

    expect(first.status).toBe(201);

    // "Yankee Anything" derives YAN again.
    const second = await POST(
      postRequest({ target: projectDir("Yankee Anything") }),
    );

    expect(second.status).toBe(409);
    expect(((await second.json()) as { message: string }).message).toContain(
      'task key "YAN"',
    );
  });

  it("rejects a malformed taskKey at the body schema (CONFIG, 422)", async () => {
    const res = await POST(
      postRequest({ target: projectDir("Valid Name"), taskKey: "bad-key" }),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");
  });
});
