// IT-ATN-11 / IT-EDGE-ATN-04 (ADR-170) — `GET /api/attention/stream`.
//
// The wire shape is asserted against the declared contract
// (`docs/api/async/attention-stream.asyncapi.yaml`), which closes its spine with
// `additionalProperties: false` — a route that emits a field the contract does
// not declare is broken even when every consumer happens to cope.
//
// Four properties, and three of them are negatives: no frame may name a project
// outside the reader's visibility (D6), a reconnect must not redeliver what it
// already had (EDGE-ATN-04), an aborted request must close the loop, and the
// stream must not write a single row of run state (D2).
//
// Every negative is asserted BESIDE a positive control. A stream that emitted
// nothing at all would satisfy "no foreign project appeared" while being
// completely broken.

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
let GET: typeof import("@/app/api/attention/stream/route").GET;

const fx = {
  member: randomUUID(),
  other: randomUUID(),
  project: randomUUID(),
  foreignProject: randomUUID(),
  flow: randomUUID(),
  foreignFlow: randomUUID(),
  task: randomUUID(),
  foreignTask: randomUUID(),
  run: randomUUID(),
};

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

interface Frame {
  id: string | null;
  event: string | null;
  data: Record<string, unknown> | null;
  comment: boolean;
}

function parseFrame(raw: string): Frame {
  if (raw.startsWith(":")) {
    return { id: null, event: null, data: null, comment: true };
  }

  const frame: Frame = { id: null, event: null, data: null, comment: false };

  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) frame.id = line.slice(4);
    if (line.startsWith("event: ")) frame.event = line.slice(7);
    if (line.startsWith("data: ")) {
      frame.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
    }
  }

  return frame;
}

/** Drains the stream for `windowMs`, then aborts it and returns every frame. */
async function collect(
  response: Response,
  controller: AbortController,
  windowMs: number,
): Promise<Frame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const deadline = Date.now() + windowMs;

  const timer = setTimeout(() => controller.abort(), windowMs);

  try {
    while (Date.now() <= deadline) {
      const { done, value } = await reader.read();

      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");

      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim() !== "") frames.push(parseFrame(part));
      }
    }
  } catch {
    /* the abort surfaces here; the frames collected so far are the result */
  } finally {
    clearTimeout(timer);
    controller.abort();
    reader.cancel().catch(() => {});
  }

  return frames;
}

/** Ticks that actually name moved projects — the "something changed" frames. */
function movedFrames(frames: Frame[]): Frame[] {
  return frames.filter(
    (frame) =>
      frame.event === "attention.tick" &&
      ((frame.data?.projectIds as string[] | undefined)?.length ?? 0) > 0,
  );
}

function streamRequest(
  controller: AbortController,
  lastEventId?: string,
): NextRequest {
  const url = new URL("http://localhost/api/attention/stream");

  if (lastEventId !== undefined)
    url.searchParams.set("lastEventId", lastEventId);

  return new NextRequest(url, { signal: controller.signal });
}

async function addActivity(
  projectId: string,
  taskId: string,
  offsetSeconds: number,
): Promise<void> {
  await pool.query(
    `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind, payload, created_at)
     values ($1, $2, $3, 'user', $4, 'comment_added', '{}'::jsonb, now() + ($5 || ' seconds')::interval)`,
    [randomUUID(), taskId, projectId, fx.other, String(offsetSeconds)],
  );
}

async function runStateSnapshot(): Promise<string> {
  const runs = await pool.query(
    `select id, status, ended_at from runs order by id`,
  );
  const cursors = await pool.query(
    `select user_id, seen_through from user_activity_cursors order by user_id`,
  );

  return JSON.stringify({ runs: runs.rows, cursors: cursors.rows });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "attention_stream_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  for (const [userId, email] of [
    [fx.member, "as-member@test.local"],
    [fx.other, "as-other@test.local"],
  ] as const) {
    await pool.query(
      `insert into users (id, email, role) values ($1, $2, 'member')`,
      [userId, email],
    );
  }
  for (const [id, slug, key] of [
    [fx.project, "as-own", "ASO"],
    [fx.foreignProject, "as-foreign", "ASF"],
  ] as const) {
    await pool.query(
      `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
       values ($1, $2, $2, $3, '/tmp/m.yaml', $4)`,
      [id, slug, `/tmp/${slug}`, key],
    );
  }
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'member')`,
    [randomUUID(), fx.project, fx.member],
  );
  for (const [flowId, projectId] of [
    [fx.flow, fx.project],
    [fx.foreignFlow, fx.foreignProject],
  ] as const) {
    await pool.query(
      `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
       values ($1, $2, 'aif', 'github.com/x/y', 'v1.0.0', '/tmp/flows/aif', $3::jsonb, 1)`,
      [
        flowId,
        projectId,
        JSON.stringify({ schemaVersion: 1, name: "aif", nodes: [] }),
      ],
    );
  }
  let number = 0;

  for (const [taskId, projectId, flowId] of [
    [fx.task, fx.project, fx.flow],
    [fx.foreignTask, fx.foreignProject, fx.foreignFlow],
  ] as const) {
    number += 1;
    await pool.query(
      `insert into tasks (id, project_id, number, title, prompt, flow_id, status, stage)
       values ($1, $2, $3, 'a task', 'p', $4, 'Backlog', 'Backlog')`,
      [taskId, projectId, number, flowId],
    );
  }
  await pool.query(
    `insert into runs (id, task_id, project_id, flow_id, status, flow_version)
     values ($1, $2, $3, $4, 'Review', 'v1.0.0')`,
    [fx.run, fx.task, fx.project, fx.flow],
  );

  ({ GET } = await import("@/app/api/attention/stream/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  session = { id: fx.member, role: "member" };
  await pool.query(`delete from task_activity`);
  await pool.query(`delete from user_activity_cursors`);
});

describe("IT-ATN-11 the stream is user-scoped", () => {
  it("opens with a snapshot tick carrying both counters and no changed region", async () => {
    const controller = new AbortController();
    const response = await GET(streamRequest(controller));

    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const frames = await collect(response, controller, 1500);
    const snapshot = frames.find((frame) => frame.event === "attention.tick");

    expect(snapshot).toBeDefined();
    expect(Object.keys(snapshot?.data ?? {}).sort()).toEqual([
      "changed",
      "decisions",
      "id",
      "occurredAt",
      "projectIds",
      "type",
      "updates",
    ]);
    expect(snapshot?.data?.type).toBe("attention.tick");
    expect(typeof snapshot?.data?.decisions).toBe("number");
    expect(typeof snapshot?.data?.updates).toBe("number");
    expect(snapshot?.data?.changed).toEqual([]);
    expect(snapshot?.data?.projectIds).toEqual([]);
    // The frame id is the replay cursor, and it is a decimal STRING on the wire.
    expect(snapshot?.data?.id).toMatch(/^(?:0|[1-9][0-9]{0,18})$/);
    expect(snapshot?.id).toBe(snapshot?.data?.id);
  }, 30_000);

  // The positive control matters more than the negative here: a stream that
  // emitted no change frames at all would "pass" the foreign-project assertion.
  it("names a visible project that moved and never an invisible one", async () => {
    const controller = new AbortController();
    const response = await GET(streamRequest(controller));

    await addActivity(fx.project, fx.task, 5);
    await addActivity(fx.foreignProject, fx.foreignTask, 5);

    const frames = await collect(response, controller, 7000);
    const changes = movedFrames(frames);

    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0].data?.changed).toContain("activity");
    const named = new Set(
      changes.flatMap((frame) => frame.data?.projectIds as string[]),
    );

    expect(named.has(fx.project)).toBe(true);
    expect(named.has(fx.foreignProject)).toBe(false);
  }, 30_000);

  it("emits no project at all for a reader who belongs to none", async () => {
    session = { id: fx.other, role: "member" };
    const controller = new AbortController();
    const response = await GET(streamRequest(controller));

    await addActivity(fx.project, fx.task, 5);

    const frames = await collect(response, controller, 6000);

    expect(
      frames.flatMap((frame) => (frame.data?.projectIds as string[]) ?? []),
    ).toEqual([]);
  }, 30_000);

  it("refuses an unauthenticated caller before opening a stream", async () => {
    session = null;
    const controller = new AbortController();
    const response = await GET(streamRequest(controller));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});

describe("IT-EDGE-ATN-04 lastEventId replays the tail once", () => {
  it("replays what is newer than the id and nothing older", async () => {
    const cutoff = Date.now();

    await addActivity(fx.project, fx.task, 5);
    // Older than the cutoff: already delivered before the reconnect.
    await pool.query(
      `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind, payload, created_at)
       values ($1, $2, $3, 'user', $4, 'comment_added', '{}'::jsonb, now() - interval '1 hour')`,
      [randomUUID(), fx.task, fx.project, fx.other],
    );

    const controller = new AbortController();
    const response = await GET(streamRequest(controller, String(cutoff)));
    const frames = await collect(response, controller, 6000);

    // A resume sends no snapshot — the tail IS the answer.
    expect(
      frames.filter(
        (frame) =>
          frame.event === "attention.tick" &&
          (frame.data?.projectIds as string[]).length === 0,
      ),
    ).toHaveLength(0);
    const changes = movedFrames(frames);

    expect(changes.length).toBe(1);
    expect(changes[0].data?.projectIds).toEqual([fx.project]);
    expect(Number(changes[0].id)).toBeGreaterThan(cutoff);
  }, 30_000);

  it("does not redeliver a project once its tail has been sent", async () => {
    const cutoff = Date.now();

    await addActivity(fx.project, fx.task, 3);
    await addActivity(fx.project, fx.task, 4);

    const controller = new AbortController();
    const response = await GET(streamRequest(controller, String(cutoff)));
    const frames = await collect(response, controller, 8000);
    const changes = movedFrames(frames);

    // Two rows, one project, several poll cycles — exactly one change frame.
    expect(changes.length).toBe(1);
  }, 30_000);

  it("clamps an unusable id to a snapshot rather than erroring", async () => {
    for (const raw of ["not-a-number", "-7", "0", "9".repeat(25)]) {
      const controller = new AbortController();
      const response = await GET(streamRequest(controller, raw));

      expect(response.status).toBe(200);
      const frames = await collect(response, controller, 1200);
      const snapshot = frames.find((frame) => frame.event === "attention.tick");

      expect(snapshot?.data?.changed, `cursor ${raw}`).toEqual([]);
    }
  }, 60_000);
});

describe("IT-ATN-11 the stream is a read path", () => {
  it("closes when the request is aborted", async () => {
    const controller = new AbortController();
    const response = await GET(streamRequest(controller));
    const reader = response.body!.getReader();

    await reader.read();
    controller.abort();

    // A closed stream ends rather than hanging: `done` arrives without a timer.
    let done = false;

    for (let attempt = 0; attempt < 10 && !done; attempt += 1) {
      done = (await reader.read()).done;
    }
    expect(done).toBe(true);
  }, 30_000);

  it("writes no run state and advances no cursor", async () => {
    await pool.query(
      `insert into user_activity_cursors (user_id, seen_through)
       values ($1, now() - interval '2 hours')`,
      [fx.member],
    );
    const before = await runStateSnapshot();
    const controller = new AbortController();
    const response = await GET(streamRequest(controller));

    await addActivity(fx.project, fx.task, 5);
    await collect(response, controller, 6000);

    expect(await runStateSnapshot()).toBe(before);
  }, 30_000);
});
