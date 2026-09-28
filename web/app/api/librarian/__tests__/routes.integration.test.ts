import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import { submitOwnerMessage } from "@/lib/librarian/admission";
import { librarianStreamFrames } from "@/lib/librarian/stream";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
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
    ]);
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
