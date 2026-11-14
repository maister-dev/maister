import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import Ajv from "ajv";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { MaisterError } from "@/lib/errors";
import { submitOwnerMessage } from "@/lib/librarian/admission";
import { cardTarget, proposeLibrarianCard } from "@/lib/librarian/cards";
import {
  forgetPersonalMemory,
  rememberPersonalMemory,
} from "@/lib/librarian/memory";
import { librarianStreamFrames } from "@/lib/librarian/stream";
import { updateLibrarianSettings } from "@/lib/librarian/settings";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
  seedLibrarianPlatform,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-185 (T2.12): every librarian session route addresses the SESSION user's
// own conversation. A `userId` is never read from a request, a global admin
// sees only their own rows, and the stream replays by `seq` without a foreign
// frame. The conversation's run stream admits its owner and no one else.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;
let session: { id: string; role: "member" | "admin" } | null = null;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireActiveSession: vi.fn(async () => {
    if (!session) throw new MaisterError("UNAUTHENTICATED", "no session");

    return session;
  }),
}));

type Routes = {
  conversation: typeof import("@/app/api/librarian/conversation/route");
  messages: typeof import("@/app/api/librarian/messages/route");
  message: typeof import("@/app/api/librarian/messages/[messageId]/route");
  runStream: typeof import("@/app/api/runs/[runId]/stream/route");
};

let routes: Routes;
let alice = "";
let bob = "";
let admin = "";

function json(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function sendAs(ownerId: string, body: string) {
  return submitOwnerMessage(
    ownerId,
    { clientMessageId: randomUUID(), body, subject: null },
    { db: db as unknown as Db, start: async () => {} },
  );
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_routes",
  });
  db = database.db as unknown as NodePgDatabase;
  await fakeExecutionHosts(db);
  await seedLibrarianPlatform(db);
  alice = await seedActiveUser(db);
  bob = await seedActiveUser(db);
  admin = await seedActiveUser(db, { role: "admin" });
  routes = {
    conversation: await import("@/app/api/librarian/conversation/route"),
    messages: await import("@/app/api/librarian/messages/route"),
    message: await import("@/app/api/librarian/messages/[messageId]/route"),
    runStream: await import("@/app/api/runs/[runId]/stream/route"),
  };
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("B1 scopes earlier actions by owner and generation and preserves tied timestamp order", async () => {
  const owner = await seedActiveUser(db);

  session = { id: owner, role: "member" };
  const conversation = await routes.conversation.GET(
    json("/api/librarian/conversation", "GET"),
  );
  const initial = await conversation.json();
  const [older, newer] = ["history-a", "history-b"];

  await database.pool.query(
    `INSERT INTO librarian_operations (id,conversation_id,segment_id,idempotency_key,kind,request_digest,target,status,result,created_at)
      VALUES ($1,$3,$4,$1,'relation_add',$1,'{}','unknown','{"body":{"secret":"private history"}}','2026-01-01T01:00:00.123456Z'),
             ($2,$3,$4,$2,'task_create',$2,'{}','succeeded',NULL,'2026-01-01T01:00:00.123456Z')`,
    [older, newer, initial.conversation.id, initial.segment.id],
  );
  const path = "/api/librarian/history/actions";
  const request = (query: string) => json(`${path}${query}`, "GET");

  const work = await routes.conversation.GET(
    json("/api/librarian/conversation?view=work", "GET"),
  );
  const workBody = await work.json();

  expect(workBody).toMatchObject({
    conversation: { historyGeneration: 0 },
    currentWork: [],
    attention: { count: 1, items: [{ id: older, outcome: "unknown" }] },
  });
  expect(JSON.stringify(workBody)).not.toContain("private history");

  const { GET } = await import("@/app/api/librarian/history/actions/route");
  const first = await GET(request("?limit=1"));
  const firstPage = await first.json();

  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(firstPage).toMatchObject({
    historyGeneration: 0,
    items: [{ id: newer }],
  });
  const cursor = "?limit=1&cursor=" + encodeURIComponent(firstPage.nextCursor);

  expect(await (await GET(request(cursor))).json()).toMatchObject({
    items: [{ id: older, targets: [{ state: "unavailable" }] }],
    nextCursor: null,
  });
  const abort = new AbortController();
  let checks = 0;
  const workFrames: string[] = [];

  for await (const frame of librarianStreamFrames({
    db: database.db,
    ownerId: owner,
    cursor: 0n,
    signal: abort.signal,
    sleep: async () => {
      if (++checks === 1) {
        await database.pool.query(
          "UPDATE librarian_operations SET status='succeeded',settled_at=now() WHERE id=$1",
          [older],
        );
      } else abort.abort();
    },
  })) {
    if (frame.includes("librarian.work")) workFrames.push(frame);
  }

  expect(workFrames).toEqual([
    'data: {"type":"librarian.work","reason":"sync"}\n\n',
    'data: {"type":"librarian.work","reason":"work"}\n\n',
  ]);
  session = { id: bob, role: "member" };
  expect((await GET(request(cursor))).status).toBe(404);
  session = { id: owner, role: "member" };
  await database.pool.query(
    "UPDATE librarian_conversations SET history_generation=1 WHERE user_id=$1",
    [owner],
  );
  expect((await GET(request(cursor))).status).toBe(409);
  expect((await GET(request("?limit=1&limit=2"))).status).toBe(422);
});

it("B1 counts unresolved work past the page cap and removes revoked target identities", async () => {
  const owner = await seedActiveUser(db);
  const project = await seedProjectRow(db);
  const taskId = randomUUID();

  session = { id: owner, role: "member" };
  await addProjectMember(db, {
    userId: owner,
    projectId: project.id,
    role: "member",
  });
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,'Private target','Private task prompt')",
    [taskId, project.id],
  );
  const conversation = await routes.conversation.GET(
    json("/api/librarian/conversation", "GET"),
  );
  const initial = await conversation.json();

  await database.pool.query(
    `INSERT INTO librarian_operations (id,conversation_id,segment_id,idempotency_key,kind,request_digest,target,status,created_at)
     SELECT $1 || ':attention:' || n, $1,$2,n::text,'task_create',n::text,jsonb_build_object('taskId',$3::text),'unknown',now() + n * interval '1 second'
     FROM generate_series(1, 31) n`,
    [initial.conversation.id, initial.segment.id, taskId],
  );
  const work = await routes.conversation.GET(
    json("/api/librarian/conversation?view=work", "GET"),
  );
  const { attention } = await work.json();

  expect(attention.count).toBe(31);
  expect(attention.items).toHaveLength(20);
  expect(attention.items[0]).toMatchObject({
    outcome: "unknown",
    targets: [{ title: "Private target", state: "visible" }],
  });
  const path = "/api/librarian/history/actions?collection=attention&limit=20";
  const { GET } = await import("@/app/api/librarian/history/actions/route");
  const first = await (await GET(json(path, "GET"))).json();
  const abort = new AbortController();
  let ticks = 0;
  const accessFrames: string[] = [];

  for await (const frame of librarianStreamFrames({
    db: database.db,
    ownerId: owner,
    cursor: 0n,
    signal: abort.signal,
    sleep: async () => {
      if (++ticks === 1)
        await removeProjectMember(db, { userId: owner, projectId: project.id });
      else abort.abort();
    },
  })) {
    if (frame.includes("librarian.work")) accessFrames.push(frame);
  }
  expect(accessFrames).toEqual([
    'data: {"type":"librarian.work","reason":"sync"}\n\n',
    'data: {"type":"librarian.work","reason":"access"}\n\n',
  ]);
  const second = await (
    await GET(
      json(`${path}&cursor=${encodeURIComponent(first.nextCursor)}`, "GET"),
    )
  ).json();

  expect(second.items).toHaveLength(11);
  expect(second.items[0]).toMatchObject({
    outcome: "unknown",
    targets: [{ state: "unavailable" }],
  });
  expect(JSON.stringify(second)).not.toContain(taskId);
  expect(JSON.stringify(second)).not.toContain(project.slug);
  expect(JSON.stringify(second)).not.toContain("Private target");
});

it("B1 invalidates stale confirmations independently of the transcript cursor", async () => {
  const owner = await seedActiveUser(db);

  session = { id: owner, role: "member" };
  const conversation = await routes.conversation.GET(
    json("/api/librarian/conversation", "GET"),
  );
  const initial = await conversation.json();
  const cardId = randomUUID();
  const memory = {
    kind: "preference",
    scope: "general",
    content: "Keep replies brief",
  } as const;
  const proposal = { action: "memory_suggest", memory } as const;
  const remembered = await rememberPersonalMemory(owner, memory, database.db);
  const { revision } = await cardTarget(proposal, owner, database.db);
  const project = await seedProjectRow(db);

  await addProjectMember(db, {
    userId: owner,
    projectId: project.id,
    role: "member",
  });
  const runId = await seedRun(db, {
    projectId: project.id,
    status: "NeedsInput",
  });
  const hitlRequestId = randomUUID();

  await database.pool.query(
    "INSERT INTO hitl_requests(id,run_id,step_id,kind,prompt) VALUES($1,$2,'review','human','Continue?')",
    [hitlRequestId, runId],
  );
  const hitl = await proposeLibrarianCard(
    {
      conversationId: initial.conversation.id,
      segmentId: initial.segment.id,
      ownerUserId: owner,
      proposal: {
        action: "hitl_respond",
        runId,
        hitlRequestId,
        response: { answer: "yes" },
      },
      recordCreated: async () => {},
    },
    database.db,
  );

  await database.pool.query(
    `INSERT INTO librarian_cards(id,conversation_id,segment_id,kind,status,target,payload,payload_digest,requires_owner,expires_at,target_revision)
     VALUES($1,$2,$3,'memory_suggestion','pending','{}',$4,'fixture',true,now() + interval '1 hour',$5)`,
    [cardId, initial.conversation.id, initial.segment.id, proposal, revision],
  );
  const { GET } = await import("@/app/api/librarian/history/actions/route");
  const response = await GET(
    json("/api/librarian/history/actions?collection=attention", "GET"),
  );
  const result = await response.json();
  const spec = parse(await readFile("../docs/api/web.openapi.yaml", "utf8"));
  const ajv = new Ajv({ strict: false, validateFormats: false });

  ajv.addSchema(spec, "maister-openapi");
  const validate = ajv.compile({
    $ref: "maister-openapi#/components/schemas/LibrarianActionHistoryPage",
  });

  expect(response.status).toBe(200);
  expect(
    result.items.find((item: { id: string }) => item.id === cardId),
  ).toMatchObject({
    id: cardId,
    confirmation: { action: "memory_suggest", available: true },
  });
  expect(
    result.items.find((item: { id: string }) => item.id === hitl.cardId),
  ).toMatchObject({
    confirmation: { action: "hitl_respond", available: true },
  });
  expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  const abort = new AbortController();
  let ticks = 0;
  const frames: string[] = [];

  for await (const frame of librarianStreamFrames({
    db: database.db,
    ownerId: owner,
    cursor: 0n,
    signal: abort.signal,
    sleep: async () => {
      ticks++;
      if (ticks === 1) {
        await database.pool.query(
          "UPDATE hitl_requests SET prompt='New question' WHERE id=$1",
          [hitlRequestId],
        );
      } else if (ticks === 2) {
        const attention = await (
          await GET(
            json("/api/librarian/history/actions?collection=attention", "GET"),
          )
        ).json();

        expect(attention.items.map((item: { id: string }) => item.id)).toEqual([
          cardId,
        ]);
        await forgetPersonalMemory(owner, remembered, database.db);
      } else abort.abort();
    },
  })) {
    if (frame.includes("librarian.work")) frames.push(frame);
  }
  expect(
    await (
      await GET(
        json("/api/librarian/history/actions?collection=attention", "GET"),
      )
    ).json(),
  ).toMatchObject({ items: [] });
  expect(
    await (
      await routes.conversation.GET(
        json("/api/librarian/conversation?view=work", "GET"),
      )
    ).json(),
  ).toMatchObject({ attention: { count: 0 }, indicator: { state: "none" } });
  expect(
    await (
      await routes.conversation.GET(json("/api/librarian/conversation", "GET"))
    ).json(),
  ).toMatchObject({ pendingCards: [] });
  const history = await (
    await GET(json("/api/librarian/history/actions", "GET"))
  ).json();

  expect(history.items.map((item: { id: string }) => item.id)).toEqual(
    expect.arrayContaining([cardId, hitl.cardId]),
  );
  expect(
    history.items.every(
      (item: { confirmation?: unknown }) => item.confirmation === undefined,
    ),
  ).toBe(true);
  expect(frames).toEqual([
    'data: {"type":"librarian.work","reason":"sync"}\n\n',
    'data: {"type":"librarian.work","reason":"work"}\n\n',
    'data: {"type":"librarian.work","reason":"work"}\n\n',
  ]);
});

describe("IT-LAU-01: the owner comes from the session, never the request", () => {
  it("refuses a userId in the message body", async () => {
    session = { id: alice, role: "member" };
    const res = await routes.messages.POST(
      json("/api/librarian/messages", "POST", {
        clientMessageId: randomUUID(),
        body: "hi",
        userId: bob,
      }),
    );

    expect(res.status).toBe(422);
  });

  it("ignores a userId in the query and answers with the caller's own conversation", async () => {
    session = { id: bob, role: "member" };
    await sendAs(bob, "bob's secret question");
    session = { id: alice, role: "member" };
    const res = await routes.messages.GET(
      json(`/api/librarian/messages?userId=${bob}`, "GET"),
    );
    const page = (await res.json()) as { messages: { body: string }[] };

    expect(res.status).toBe(200);
    expect(JSON.stringify(page)).not.toContain("bob's secret question");
  });

  it("stores a posted message for the session user and answers 202, a repeat 200", async () => {
    session = { id: alice, role: "member" };
    const clientMessageId = randomUUID();
    const first = await routes.messages.POST(
      json("/api/librarian/messages", "POST", { clientMessageId, body: "hi" }),
    );
    const again = await routes.messages.POST(
      json("/api/librarian/messages", "POST", { clientMessageId, body: "hi" }),
    );

    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect((await first.json()).message.seq).toMatch(/^[1-9][0-9]*$/);
  });

  it("refuses a subject naming a project the owner cannot see with 404", async () => {
    session = { id: alice, role: "member" };
    const res = await routes.messages.POST(
      json("/api/librarian/messages", "POST", {
        clientMessageId: randomUUID(),
        body: "about that",
        subject: { projectSlug: "nowhere-to-be-seen" },
      }),
    );

    expect(res.status).toBe(404);
  });
});

describe("IT-LAU-09 IT-EDGE-LAU-02: a global admin reaches only their own conversation", () => {
  it("returns the admin's own conversation and hides every other user's message", async () => {
    const bobMessage = await sendAs(bob, "private to bob");

    session = { id: admin, role: "admin" };
    const view = await routes.conversation.GET();
    const body = (await view.json()) as { conversation: { id: string } };
    const [bobConversation] = (
      (await db.execute(sql`
        SELECT id FROM librarian_conversations WHERE user_id = ${bob}
      `)) as unknown as { rows: { id: string }[] }
    ).rows;

    expect(view.status).toBe(200);
    expect(body.conversation.id).not.toBe(bobConversation.id);
    const list = await routes.messages.GET(
      json("/api/librarian/messages", "GET"),
    );

    expect(JSON.stringify(await list.json())).not.toContain("private to bob");
    const withdraw = await routes.message.DELETE(
      json(`/api/librarian/messages/${bobMessage.message.id}`, "DELETE"),
      { params: Promise.resolve({ messageId: bobMessage.message.id }) },
    );

    expect(withdraw.status).toBe(404);
  });
});

describe("IT-LCV-12: the stream replays by seq and carries no foreign frame", () => {
  it("reports saved runner, readiness and same-id config changes without a message cursor", async () => {
    const owner = await seedActiveUser(db);
    const original = await seedLibrarianPlatform(db);
    const next = await seedLibrarianPlatform(db, { ready: false });

    await updateLibrarianSettings(
      { enabled: true, runnerId: original.runnerId },
      admin,
      db,
    );
    const abort = new AbortController();
    const frames: string[] = [];
    let iteration = 0;

    for await (const frame of librarianStreamFrames({
      db: db as unknown as Db,
      ownerId: owner,
      cursor: 7n,
      signal: abort.signal,
      sleep: async () => {
        iteration += 1;
        if (iteration === 1)
          await updateLibrarianSettings(
            { enabled: true, runnerId: next.runnerId },
            admin,
            db,
          );
        else if (iteration === 2)
          await db.execute(
            sql`UPDATE platform_acp_runners SET readiness_status = 'Ready' WHERE id = ${next.runnerId}`,
          );
        else if (iteration === 3)
          await db.execute(
            sql`UPDATE platform_acp_runners SET model = 'claude-opus-4-6', env = '{"TEST_SECRET_REF":"env:PRIVATE"}'::jsonb WHERE id = ${next.runnerId}`,
          );
        else abort.abort();
      },
    }))
      frames.push(frame);

    expect(frames).toHaveLength(5);
    expect(frames).toContain(
      'data: {"type":"librarian.work","reason":"sync"}\n\n',
    );
    for (const frame of frames.filter(
      (entry) => !entry.includes("librarian.work"),
    )) {
      expect(frame).toBe('data: {"type":"librarian.settings"}\n\n');
    }
    const reconnect = librarianStreamFrames({
      db: db as unknown as Db,
      ownerId: owner,
      cursor: 7n,
      signal: new AbortController().signal,
    });

    try {
      expect((await reconnect.next()).value).toBe(frames[0]);
    } finally {
      await reconnect.return(undefined);
    }
  });

  it("uses the quiet poll interval while the librarian is disabled", async () => {
    const owner = await seedActiveUser(db);
    const abort = new AbortController();
    const delays: number[] = [];

    await db.execute(sql`
      UPDATE platform_runtime_settings SET librarian_enabled = false
      WHERE id = 'singleton'
    `);
    try {
      const frames = librarianStreamFrames({
        db: db as unknown as Db,
        ownerId: owner,
        cursor: null,
        signal: abort.signal,
        sleep: async (ms) => {
          delays.push(ms);
          abort.abort();
        },
      });

      expect((await frames.next()).value).toContain('"librarian.settings"');
      expect((await frames.next()).value).toContain('"librarian.work"');
      expect((await frames.next()).done).toBe(true);
      expect(delays).toEqual([30_000]);
    } finally {
      await db.execute(sql`
        UPDATE platform_runtime_settings SET librarian_enabled = true
        WHERE id = 'singleton'
      `);
    }
  });

  it("replays the messages after the cursor, then the state frames", async () => {
    const owner = await seedActiveUser(db);
    const other = await seedActiveUser(db);

    await sendAs(owner, "one");
    await sendAs(other, "other user's line");
    await sendAs(owner, "two");
    const abort = new AbortController();
    const frames: string[] = [];

    for await (const frame of librarianStreamFrames({
      db: db as unknown as Db,
      ownerId: owner,
      cursor: 1n,
      signal: abort.signal,
      sleep: async () => abort.abort(),
    })) {
      frames.push(frame);
    }
    const parsed = frames.map((frame) => ({
      id: /^id: (.+)$/m.exec(frame)?.[1] ?? null,
      data: JSON.parse(/^data: (.+)$/m.exec(frame)![1]) as {
        type: string;
        seq?: string;
      },
    }));

    expect(parsed[0]).toMatchObject({
      id: "2",
      data: { type: "librarian.message", seq: "2" },
    });
    expect(parsed.map((f) => f.data.type)).toEqual([
      "librarian.message",
      "librarian.turn",
      "librarian.indicator",
      "librarian.settings",
      "librarian.work",
    ]);
    expect(parsed.at(-1)).toEqual({
      id: null,
      data: { type: "librarian.work", reason: "sync" },
    });
    expect(JSON.stringify(parsed)).not.toContain("other user");
  });

  it("the conversation's run stream admits the owner and refuses another member", async () => {
    const owner = await seedActiveUser(db);
    const other = await seedActiveUser(db);

    await sendAs(owner, "stream me");
    const [run] = (
      (await db.execute(sql`
        SELECT run_id FROM librarian_conversations WHERE user_id = ${owner}
      `)) as unknown as { rows: { run_id: string }[] }
    ).rows;
    const open = async (userId: string) => {
      session = { id: userId, role: "member" };
      const res = await routes.runStream.GET(
        json(`/api/runs/${run.run_id}/stream`, "GET"),
        { params: Promise.resolve({ runId: run.run_id }) },
      );

      await res.body?.cancel().catch(() => undefined);

      return res.status;
    };

    expect(await open(owner)).toBe(200);
    expect(await open(other)).toBe(403);
  });
});
