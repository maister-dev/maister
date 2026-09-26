import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
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
import { admitNextLibrarianTurn, submitOwnerMessage } from "@/lib/librarian/admission";
import { clearLibrarianHistory, previewLibrarianClear } from "@/lib/librarian/clear-history";
import { lockOwnerConversation } from "@/lib/librarian/conversation";
import { startLibrarianTurn } from "@/lib/librarian/runtime";
import { queueLibrarianSummary } from "@/lib/librarian/summary";
import {
  runLibrarianTurnSweep,
  stopLibrarianTurn,
} from "@/lib/librarian/turn-recovery";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  unknownOutcomeError,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import {
  seedActiveUser,
  seedLibrarianPlatform,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-183 (T2.10, T2.11): a librarian turn end to end over the fake host —
// context snapshot before the prompt, an MCP-only session, the reply stored,
// the token revoked and the run parked by the turn's own prompt owner; and the
// stop, host-loss and deadline arms that end a turn by another path.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;
let fake: FakeExecutionHost;
let hosts: ExecutionHosts;
let running: Promise<void>[] = [];
let prompts: string[] = [];

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

function rows<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

function start(turnId: string): Promise<void> {
  const turn = startLibrarianTurn(turnId, {
    db: db as unknown as Db,
    hosts,
  });

  running.push(turn);

  return turn;
}

async function settle(): Promise<void> {
  // A finished turn may start its queued successor; drain until quiet.
  for (let i = 0; i < 10 && running.length > 0; i += 1) {
    const batch = running;

    running = [];
    await Promise.all(batch);
  }
}

async function send(ownerId: string, body: string) {
  return submitOwnerMessage(
    ownerId,
    { clientMessageId: randomUUID(), body, subject: null },
    { db: db as unknown as Db, start },
  );
}

function reply(text: string, extra: SupervisorEvent[] = []): void {
  fake.setStreamEvents([
    ...extra,
    {
      type: "session.update",
      sessionId: "fake",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    } as SupervisorEvent,
  ]);
}

let lostTurn = false;

function gatedPrompt(): { release: () => void; entered: Promise<void> } {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));

  fake.setPromptBehavior(async (ctx) => {
    prompts.push(ctx.envelope.payload.prompt);
    entered();
    await gate;
    if (lostTurn) {
      lostTurn = false;
      fake.setPromptBehavior(async (next) => {
        prompts.push(next.envelope.payload.prompt);

        return { stopReason: "end_turn", meta: null };
      });
      throw unknownOutcomeError("fake: host lost the turn");
    }

    return { stopReason: "end_turn", meta: null };
  });

  return { release, entered: enteredPromise };
}

async function turnRow(turnId: string) {
  return rows<{
    status: string;
    failure_reason: string | null;
    context_snapshot_id: string | null;
  }>(
    await db.execute(sql`
      SELECT status, failure_reason, context_snapshot_id
      FROM librarian_turns WHERE id = ${turnId}
    `),
  )[0];
}

async function conversationState(ownerId: string) {
  return rows<{ run_status: string; run_id: string }>(
    await db.execute(sql`
      SELECT r.status AS run_status, r.id AS run_id FROM librarian_conversations c
      JOIN runs r ON r.id = c.run_id WHERE c.user_id = ${ownerId}
    `),
  )[0];
}

async function tokenRevoked(turnId: string): Promise<boolean> {
  const [row] = rows<{ revoked: boolean }>(
    await db.execute(sql`
      SELECT bool_and(revoked_at IS NOT NULL) AS revoked FROM project_tokens
      WHERE librarian_turn_id = ${turnId}
    `),
  );

  return row.revoked === true;
}

function creates(): Record<string, unknown>[] {
  return fake
    .callsOf("createSession")
    .map((call) => (call.envelope?.payload ?? {}) as Record<string, unknown>);
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "librarian_turn" });
  db = database.db as unknown as NodePgDatabase;
  fake = createFakeExecutionHost();
  ({ hosts } = await fakeExecutionHosts(db, { fake }));
  await seedLibrarianPlatform(db);
}, 180_000);

afterAll(async () => {
  await settle();
  await database?.stop();
});

beforeEach(async () => {
  await settle();
  prompts = [];
  fake.setPromptBehavior(async (ctx) => {
    prompts.push(ctx.envelope.payload.prompt);

    return { stopReason: "end_turn", meta: null };
  });
  reply("default reply");
});

describe("IT-LCV-04 part 3: a turn round-trips through its own prompt owner", () => {
  it("stores the reply, revokes the token and parks the run", async () => {
    const ownerId = await seedActiveUser(db);

    reply("Here are your tasks.");
    const sent = await send(ownerId, "what is on my plate?");

    await settle();
    const turn = await turnRow(sent.turn!.id);
    const messages = rows<{
      author_kind: string;
      body: string;
      delivery_state: string;
    }>(
      await db.execute(sql`
        SELECT m.author_kind, m.body, m.delivery_state FROM librarian_messages m
        JOIN librarian_conversations c ON c.id = m.conversation_id
        WHERE c.user_id = ${ownerId} ORDER BY m.seq
      `),
    );

    expect(turn.status).toBe("completed");
    expect(messages).toEqual([
      {
        author_kind: "owner",
        body: "what is on my plate?",
        delivery_state: "processed",
      },
      {
        author_kind: "librarian",
        body: "Here are your tasks.",
        delivery_state: "processed",
      },
    ]);
    expect(await tokenRevoked(sent.turn!.id)).toBe(true);
    expect((await conversationState(ownerId)).run_status).toBe(
      "NeedsInputIdle",
    );
    expect(prompts.at(-1)).toContain("what is on my plate?");
  });

  it("IT-LAU-11 (send site): the session is MCP-only, auto-approved, never readOnlySession", async () => {
    const ownerId = await seedActiveUser(db);

    await send(ownerId, "hello");
    await settle();
    const payload = creates().at(-1)!;
    const servers = payload.mcpServers as {
      name: string;
      env: Record<string, string>;
    }[];

    expect(payload).not.toHaveProperty("readOnlySession");
    expect(payload.autoApprovePermissions).toBe(true);
    expect(payload.enforcementProfile).toMatchObject({
      mcps: { allowServers: ["maister"] },
      enforcedClasses: ["tools", "mcps"],
      escalationThreshold: 3,
    });
    expect(
      (payload.enforcementProfile as { tools: { allow: string[] } }).tools
        .allow,
    ).toContain("mcp__maister__task_search");
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("maister");
    expect(servers[0].env.MAISTER_MCP_TOOLSET).toBe("librarian");
    expect(servers[0].env.MAISTER_PROJECT_TOKEN).toMatch(/\S/);
  });

  it("IT-LCV-07 part 2: no prompt command exists before its turn's snapshot", async () => {
    const ownerId = await seedActiveUser(db);
    const sent = await send(ownerId, "snapshot first");

    await settle();
    const [order] = rows<{ snapshot_at: Date; command_at: Date }>(
      await db.execute(sql`
        SELECT s.created_at AS snapshot_at, c.created_at AS command_at
        FROM librarian_turns t
        JOIN librarian_context_snapshots s ON s.id = t.context_snapshot_id
        JOIN execution_commands c ON c.owner_kind = 'librarian_turn'
          AND c.owner_ref->>'turnId' = t.id
        WHERE t.id = ${sent.turn!.id}
      `),
    );

    expect(order).toBeDefined();
    expect(new Date(order.snapshot_at).getTime()).toBeLessThanOrEqual(
      new Date(order.command_at).getTime(),
    );
  });
});

describe("IT-LAU-11 part 2: a guard halt fails the turn without a HITL row", () => {
  it("ends the turn failed{capability_trip} and writes no hitl_requests row", async () => {
    const ownerId = await seedActiveUser(db);

    reply("partial", [
      {
        type: "session.hook_trip",
        sessionId: "fake",
        monotonicId: 1,
        rule: "capability_guard",
        lifecycle: "pre_tool_call",
        disposition: "halt",
        toolCall: { title: "Read" },
      } as unknown as SupervisorEvent,
    ]);
    const sent = await send(ownerId, "read my disk");

    await settle();
    const turn = await turnRow(sent.turn!.id);
    const { run_id: runId } = await conversationState(ownerId);
    const [hitl] = rows<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM hitl_requests WHERE run_id = ${runId}
      `),
    );

    expect(turn).toMatchObject({
      status: "failed",
      failure_reason: "capability_trip",
    });
    expect(hitl.n).toBe(0);
    expect(await tokenRevoked(sent.turn!.id)).toBe(true);
  });
});

describe("IT-LCV-06: session/resume only under the same epoch and runner", () => {
  it("resumes a matching session, starts new after an epoch or runner change", async () => {
    const ownerId = await seedActiveUser(db);

    await send(ownerId, "one");
    await settle();
    const firstCreate = creates().length;

    await send(ownerId, "two");
    await settle();
    expect(creates()[firstCreate]).toHaveProperty("resumeSessionId");
    expect(prompts.at(-1)).not.toContain("Conversation so far");

    await db.execute(sql`
      UPDATE librarian_conversations SET context_epoch = context_epoch + 1
      WHERE user_id = ${ownerId}
    `);
    await send(ownerId, "three");
    await settle();
    expect(creates().at(-1)).not.toHaveProperty("resumeSessionId");
    expect(prompts.at(-1)).toContain("Conversation so far");

    await seedLibrarianPlatform(db, { runnerId: `lib-other-${randomUUID()}` });
    await send(ownerId, "four");
    await settle();
    expect(creates().at(-1)).not.toHaveProperty("resumeSessionId");
  });
});

describe("IT-LMM-07: a summary uses an isolated, tool-free session", () => {
  async function queueSummary(ownerId: string): Promise<{ conversationId: string; turnId: string }> {
    await send(ownerId, "start conversation");
    await settle();
    const { conversation, segment } = await db.transaction((tx) =>
      lockOwnerConversation(tx as never, ownerId));
    const messageId = randomUUID();

    await db.execute(sql`INSERT INTO librarian_messages
      (id, conversation_id, segment_id, seq, author_kind, body, delivery_state)
      VALUES (${messageId}, ${conversation.id}, ${segment.id}, 3,
        'owner', ${"A".repeat(31_000)}, 'processed')`);
    await db.execute(sql`UPDATE librarian_conversations SET last_seq = 3 WHERE id = ${conversation.id}`);
    await db.transaction((tx) => queueLibrarianSummary(tx as never, conversation, segment.id));
    const [queued] = rows<{ id: string }>(await db.execute(sql`
      SELECT id FROM librarian_turns WHERE segment_id = ${segment.id}
        AND variant = 'summary' AND status = 'queued'
    `));

    expect(queued).toBeDefined();

    return { conversationId: conversation.id, turnId: queued.id };
  }

  it("runs a new session with no token or MCP server and stores structured summary", async () => {
    const ownerId = await seedActiveUser(db);
    const queued = await queueSummary(ownerId);

    reply(JSON.stringify({ decisions: ["Keep the accepted plan"], proposals: [], uncertainties: [] }));
    await admitNextLibrarianTurn(queued.conversationId, { db: db as unknown as Db, start });
    await settle();
    const payload = creates().at(-1)!;

    expect(payload).not.toHaveProperty("resumeSessionId");
    expect(payload.mcpServers).toEqual([]);
    expect(payload.enforcementProfile).toMatchObject({
      mcps: { allowServers: [] }, escalationThreshold: 1,
    });
    expect((await turnRow(queued.turnId)).status).toBe("completed");
    const [tokenCount] = rows<{ count: number }>(await db.execute(sql`
      SELECT count(*)::int AS count FROM project_tokens
      WHERE librarian_turn_id = ${queued.turnId}
    `));
    const summaries = rows<{ content: { decisions: string[] } }>(await db.execute(sql`
      SELECT content FROM librarian_segment_summaries WHERE segment_id =
        (SELECT segment_id FROM librarian_turns WHERE id = ${queued.turnId})
    `));

    expect(tokenCount.count).toBe(0);
    expect(summaries.at(-1)?.content.decisions).toEqual(["Keep the accepted plan"]);
  });

  it("fails the summary if the adapter reports a tool call", async () => {
    const ownerId = await seedActiveUser(db);
    const queued = await queueSummary(ownerId);

    reply("{}", [{
      type: "session.update", sessionId: "fake", monotonicId: 1,
      update: { sessionUpdate: "tool_call", toolCallId: "forbidden", title: "Read" },
    } as unknown as SupervisorEvent]);
    await admitNextLibrarianTurn(queued.conversationId, { db: db as unknown as Db, start });
    await settle();
    expect(await turnRow(queued.turnId)).toMatchObject({
      status: "failed", failure_reason: "capability_trip",
    });
    await expect.poll(async () => {
      const [row] = rows<{ count: number }>(await db.execute(sql`
        SELECT count(*)::int AS count FROM librarian_turns
        WHERE conversation_id = ${queued.conversationId}
          AND variant = 'summary' AND status = 'failed'
      `));

      return row.count;
    }, { timeout: 20_000 }).toBe(2);
  });
});

describe("IT-LMM-08: clear releases the host workspace and re-adopts on the next turn", () => {
  it("purges the conversation history, releases its workspace and creates a fresh session", async () => {
    const ownerId = await seedActiveUser(db);

    await send(ownerId, "before clear");
    await settle();
    const preview = await previewLibrarianClear(ownerId, db as unknown as Db);
    const releaseCount = fake.callsOf("releaseWorkspace").length;
    const adoptCount = fake.callsOf("adoptWorkspace").length;
    const createCount = creates().length;

    expect(await clearLibrarianHistory(ownerId, preview.previewDigest,
      db as unknown as Db, hosts)).toBe("none");
    expect(fake.callsOf("releaseWorkspace")).toHaveLength(releaseCount + 1);
    const [historyCount] = rows<{ count: number }>(await db.execute(sql`
      SELECT count(*)::int AS count FROM librarian_messages m
      JOIN librarian_conversations c ON c.id = m.conversation_id
      WHERE c.user_id = ${ownerId}
    `));

    expect(historyCount.count).toBe(0);
    await send(ownerId, "after clear");
    await settle();
    expect(fake.callsOf("adoptWorkspace")).toHaveLength(adoptCount + 1);
    const newSessions = creates().slice(createCount);

    expect(newSessions.length).toBeGreaterThan(0);
    for (const session of newSessions)
      expect(session).not.toHaveProperty("resumeSessionId");
    expect(prompts.at(-1)).not.toContain("before clear");
  });
});

describe("IT-LCV-08: stop ends the librarian turn only", () => {
  it("stops the running turn, revokes its token, and leaves the owner's task run alone", async () => {
    const ownerId = await seedActiveUser(db);
    const projectId = await seedProject(db);
    const taskRunId = await seedRun(db, {
      projectId,
      runKind: "flow",
      status: "Running",
    });
    const gate = gatedPrompt();
    const sent = await send(ownerId, "long question");

    await gate.entered;
    await stopLibrarianTurn(ownerId, db as unknown as Db);
    const turn = await turnRow(sent.turn!.id);

    expect(turn.status).toBe("stopped");
    expect(await tokenRevoked(sent.turn!.id)).toBe(true);
    expect((await conversationState(ownerId)).run_status).toBe(
      "NeedsInputIdle",
    );
    expect(fake.callsOf("cancelPrompt").length).toBeGreaterThan(0);
    gate.release();
    await settle();
    // The late prompt outcome is superseded; the turn stays stopped.
    expect((await turnRow(sent.turn!.id)).status).toBe("stopped");
    const [taskRun] = rows<{ status: string }>(
      await db.execute(sql`SELECT status FROM runs WHERE id = ${taskRunId}`),
    );

    expect(taskRun.status).toBe("Running");
    await expect(
      stopLibrarianTurn(ownerId, db as unknown as Db),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("IT-LCV-09 part 2: a host lost mid-turn fails the turn and admits the next", () => {
  it("fails host_lost, then runs the message queued behind it", async () => {
    const ownerId = await seedActiveUser(db);
    const gate = gatedPrompt();
    const first = await send(ownerId, "first");

    await gate.entered;
    const second = await send(ownerId, "second");

    expect(second.turn?.status).toBe("queued");
    // The host loses the accepted turn: the caller's request breaks with an
    // unknown outcome while the receipt stays `accepted` — turn_lost.
    lostTurn = true;
    gate.release();
    await settle();
    expect(await turnRow(first.turn!.id)).toMatchObject({
      status: "failed",
      failure_reason: "host_lost",
    });
    // The owner's after-commit starts the queued successor on its own.
    await expect
      .poll(async () => (await turnRow(second.turn!.id)).status, {
        timeout: 20_000,
      })
      .toBe("completed");
  });
});

describe("IT-EDGE-LCV-04: the deadline ends a turn mid tool call", () => {
  it("cancels the prompt, fails the turn `deadline` and revokes the token", async () => {
    const ownerId = await seedActiveUser(db);
    const gate = gatedPrompt();
    const sent = await send(ownerId, "slow one");

    await gate.entered;
    await db.execute(sql`
      UPDATE librarian_turns SET deadline_at = now() - interval '1 second'
      WHERE id = ${sent.turn!.id}
    `);
    const cancelsBefore = fake.callsOf("cancelPrompt").length;
    const summary = await runLibrarianTurnSweep(db as unknown as Db);

    expect(summary.deadlines).toBe(1);
    expect(fake.callsOf("cancelPrompt").length).toBeGreaterThan(cancelsBefore);
    expect(await turnRow(sent.turn!.id)).toMatchObject({
      status: "failed",
      failure_reason: "deadline",
    });
    expect(await tokenRevoked(sent.turn!.id)).toBe(true);
    gate.release();
    await settle();
  });
});

describe("Deferred release: a failure after the prompt is issued cancels it first", () => {
  it("cancels the prompt and revokes the token when the prompt call fails", async () => {
    const ownerId = await seedActiveUser(db);
    const cancelsBefore = fake.callsOf("cancelPrompt").length;

    fake.failOnce(
      "startPrompt",
      new MaisterError("EXECUTOR_UNAVAILABLE", "fake: prompt not sent", {
        details: { transport: "not_sent" },
      }),
    );
    const sent = await send(ownerId, "doomed");

    await settle();
    expect(await turnRow(sent.turn!.id)).toMatchObject({ status: "failed" });
    expect(fake.callsOf("cancelPrompt").length).toBeGreaterThan(cancelsBefore);
    expect(await tokenRevoked(sent.turn!.id)).toBe(true);
    expect((await conversationState(ownerId)).run_status).toBe(
      "NeedsInputIdle",
    );
  });
});
