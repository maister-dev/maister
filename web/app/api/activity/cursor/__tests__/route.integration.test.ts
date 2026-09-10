// IT-ATN-10 / EDGE-ATN-03 (ADR-168 D3) — `POST /api/activity/cursor`.
//
// The cursor is the one piece of persisted state the attention plane owns, and
// the only operation on it is an advance. Every case below is about what MUST
// NOT happen: it must not go backwards on a stale or out-of-order request, it
// must not run ahead of the events it marks, and it must not be reachable for
// anyone but the session's own user.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
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

import { MaisterError } from "@/lib/errors";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let POST: typeof import("@/app/api/activity/cursor/route").POST;
let getUpdatesCount: typeof import("@/lib/queries/updates").getUpdatesCount;

const fx = {
  member: randomUUID(),
  other: randomUUID(),
  project: randomUUID(),
  task: randomUUID(),
};

const EARLY = new Date("2026-09-10T09:00:00.000Z");
const MID = new Date("2026-09-10T10:00:00.000Z");
const LATE = new Date("2026-09-10T11:00:00.000Z");

let session: { id: string; role: "member" | "admin" } | null = {
  id: fx.member,
  role: "member",
};

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => {
    if (!session) throw new MaisterError("UNAUTHENTICATED", "no session");

    return session;
  }),
}));

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/activity/cursor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function storedCursor(userId: string): Promise<string | null> {
  const rows = await pool.query(
    `select seen_through from user_activity_cursors where user_id = $1`,
    [userId],
  );

  return rows.rows[0]
    ? new Date(rows.rows[0].seen_through as string).toISOString()
    : null;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "activity_cursor_route_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  for (const [userId, email] of [
    [fx.member, "cur-member@test.local"],
    [fx.other, "cur-other@test.local"],
  ] as const) {
    await pool.query(
      `insert into users (id, email, role) values ($1, $2, 'member')`,
      [userId, email],
    );
  }
  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, 'cur-own', 'cur-own', '/tmp/cur-own', '/tmp/m.yaml', 'CUR')`,
    [fx.project],
  );
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'member')`,
    [randomUUID(), fx.project, fx.member],
  );
  await pool.query(
    `insert into tasks (id, project_id, number, title, prompt, status, stage)
     values ($1, $2, 1, 'a task', 'p', 'Backlog', 'Backlog')`,
    [fx.task, fx.project],
  );

  ({ POST } = await import("@/app/api/activity/cursor/route"));
  ({ getUpdatesCount } = await import("@/lib/queries/updates"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  session = { id: fx.member, role: "member" };
  await pool.query(`delete from user_activity_cursors`);
  await pool.query(`delete from task_activity`);
});

describe("IT-ATN-10 the cursor only ever moves forward", () => {
  it("writes the first cursor for a reader who has never looked", async () => {
    expect(await storedCursor(fx.member)).toBeNull();

    const response = await POST(post({ seenThrough: MID.toISOString() }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      seenThrough: MID.toISOString(),
    });
    expect(await storedCursor(fx.member)).toBe(MID.toISOString());
  });

  it("advances on a newer timestamp", async () => {
    await POST(post({ seenThrough: MID.toISOString() }));
    const response = await POST(post({ seenThrough: LATE.toISOString() }));

    await expect(response.json()).resolves.toEqual({
      seenThrough: LATE.toISOString(),
    });
    expect(await storedCursor(fx.member)).toBe(LATE.toISOString());
  });

  // The out-of-order case: a slow tab finishes after a newer one. `GREATEST`
  // absorbs it, and the response hands back what is STORED so the caller can
  // see that its request did not win.
  it("absorbs a stale request instead of rewinding", async () => {
    await POST(post({ seenThrough: LATE.toISOString() }));
    const response = await POST(post({ seenThrough: EARLY.toISOString() }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      seenThrough: LATE.toISOString(),
    });
    expect(await storedCursor(fx.member)).toBe(LATE.toISOString());
  });

  it("is idempotent for a replayed request", async () => {
    await POST(post({ seenThrough: MID.toISOString() }));
    await POST(post({ seenThrough: MID.toISOString() }));

    expect(await storedCursor(fx.member)).toBe(MID.toISOString());
    const rows = await pool.query(
      `select count(*)::int as n from user_activity_cursors where user_id = $1`,
      [fx.member],
    );

    expect(rows.rows[0].n).toBe(1);
  });

  it("absorbs a stale request even when it lands concurrently", async () => {
    await Promise.all([
      POST(post({ seenThrough: LATE.toISOString() })),
      POST(post({ seenThrough: EARLY.toISOString() })),
      POST(post({ seenThrough: MID.toISOString() })),
    ]);

    expect(await storedCursor(fx.member)).toBe(LATE.toISOString());
  });
});

describe("EDGE-ATN-03 a cursor cannot run ahead of the events it marks", () => {
  it("refuses a future timestamp with PRECONDITION and writes nothing", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const response = await POST(post({ seenThrough: future.toISOString() }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "PRECONDITION",
    });
    expect(await storedCursor(fx.member)).toBeNull();
  });

  it("leaves an existing cursor untouched when a future advance is refused", async () => {
    await POST(post({ seenThrough: MID.toISOString() }));
    const future = new Date(Date.now() + 60 * 60 * 1000);

    expect(
      (await POST(post({ seenThrough: future.toISOString() }))).status,
    ).toBe(409);
    expect(await storedCursor(fx.member)).toBe(MID.toISOString());
  });

  it("rejects a body that is not an ISO timestamp", async () => {
    for (const body of [
      {},
      { seenThrough: "yesterday" },
      { seenThrough: 17 },
    ]) {
      const response = await POST(post(body));

      expect(response.status).toBe(400);
    }
    expect(await storedCursor(fx.member)).toBeNull();
  });

  it("rejects a malformed JSON body without crashing", async () => {
    expect((await POST(post("{not json"))).status).toBe(400);
  });
});

describe("the cursor is the session's own", () => {
  it("refuses an unauthenticated caller", async () => {
    session = null;

    expect((await POST(post({ seenThrough: MID.toISOString() }))).status).toBe(
      401,
    );
    expect(await storedCursor(fx.member)).toBeNull();
  });

  it("never touches another reader's cursor", async () => {
    await POST(post({ seenThrough: MID.toISOString() }));
    session = { id: fx.other, role: "member" };
    await POST(post({ seenThrough: LATE.toISOString() }));

    expect(await storedCursor(fx.member)).toBe(MID.toISOString());
    expect(await storedCursor(fx.other)).toBe(LATE.toISOString());
  });
});

describe("the advance is what the updates counter reads", () => {
  it("stops counting activity the reader has now seen", async () => {
    await pool.query(
      `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind, payload, created_at)
       values ($1, $2, $3, 'user', $4, 'comment_added', '{}'::jsonb, $5)`,
      [randomUUID(), fx.task, fx.project, fx.other, MID],
    );

    expect(await getUpdatesCount(fx.member, "member", LATE)).toBe(1);
    await POST(post({ seenThrough: LATE.toISOString() }));
    expect(await getUpdatesCount(fx.member, "member", LATE)).toBe(0);
  });
});
