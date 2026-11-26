import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  librarianMessages,
  librarianSegmentSummaries,
  librarianTurns,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import {
  admitNextLibrarianTurn,
  submitOwnerMessage,
} from "@/lib/librarian/admission";
import {
  clearLibrarianHistory,
  previewLibrarianClear,
} from "@/lib/librarian/clear-history";
import {
  appendConversationMessage,
  lockOwnerConversation,
} from "@/lib/librarian/conversation";
import {
  listPersonalMemory,
  rememberPersonalMemory,
} from "@/lib/librarian/memory";
import { admitLibrarianOperation } from "@/lib/librarian/operations";
import * as librarianRuntime from "@/lib/librarian/runtime";
import { updateLibrarianSettings } from "@/lib/librarian/settings";
import { queueLibrarianSummary } from "@/lib/librarian/summary";
import {
  getLibrarianWorkView,
  librarianMessageDtos,
} from "@/lib/librarian/view";
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
import {
  seedProject,
  seedProjectRow,
  seedRun,
} from "@/test-support/execution-host-seed";
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

// ADR-185 (T2.10, T2.11): a librarian turn end to end over the fake host —
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
  const turn = librarianRuntime.startLibrarianTurn(turnId, {
    db: db as unknown as Db,
    hosts,
  });

  return turn;
}

async function settle(): Promise<void> {
  // A finished turn may start its queued successor; join every actual lifetime.
  const failures: unknown[] = [];

  for (let i = 0; i < 10 && running.length > 0; i += 1) {
    const batch = running;

    running = [];
    const results = await Promise.allSettled(batch);

    for (const result of results)
      if (result.status === "rejected") failures.push(result.reason);
  }
  if (running.length > 0)
    throw new Error(
      "Librarian turn fixture exceeded its bounded successor drain",
    );
  if (failures.length > 0)
    throw new AggregateError(failures, "Librarian turn fixture did not settle");
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
  const startTurn = librarianRuntime.startLibrarianTurn;

  // Observe the real runtime, including after-commit dispatch outside start().
  vi.spyOn(librarianRuntime, "startLibrarianTurn").mockImplementation(
    (...arguments_) => {
      const turn = startTurn(...arguments_);

      running.push(turn);

      return turn;
    },
  );
}, 180_000);

afterAll(async () => {
  try {
    await settle();
  } finally {
    vi.restoreAllMocks();
    await database?.stop();
  }
});

// A failed assertion must not leave its successor using the next fake host state.
afterEach(async () => {
  try {
    await settle();
  } finally {
    vi.unstubAllEnvs();
  }
}, 30_000);

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

  it("commits terminal turn evidence before an unavailable host prevents successor admission", async () => {
    const ownerId = await seedActiveUser(db);
    const gate = gatedPrompt();
    const sent = await send(ownerId, "hold this turn");
    const turnId = sent.turn!.id;

    await gate.entered;
    try {
      fake.setHealth({
        kind: "unavailable",
        reason: "network",
        message: "fixture supervisor is unavailable",
      });
      resetResolverForTests();

      await expect(
        librarianRuntime.endLibrarianTurn(db as unknown as Db, turnId, {
          status: "failed",
          reason: "deadline",
        }),
      ).resolves.toBe(true);
      expect((await turnRow(turnId)).status).toBe("failed");
      expect(await tokenRevoked(turnId)).toBe(true);
      expect((await conversationState(ownerId)).run_status).toBe(
        "NeedsInputIdle",
      );
    } finally {
      fake.setHealth(null);
      try {
        await fakeExecutionHosts(db, { fake });
      } finally {
        gate.release();
      }
    }
  });

  it("IT-LAU-11 (send site): the session is MCP-only, auto-approved, never readOnlySession", async () => {
    vi.stubEnv("MAISTER_MCP_FACADE_COMMAND", "/fixtures/local-maister-mcp");
    const ownerId = await seedActiveUser(db);

    const before = creates().length;

    await send(ownerId, "hello");
    await settle();
    const payloads = creates().slice(before);

    expect(payloads).toHaveLength(1);
    const [payload] = payloads;
    const servers = payload.mcpServers as {
      name: string;
      command: string;
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
    expect(servers[0].command).toBe("/fixtures/local-maister-mcp");
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

describe("IT-LCV-04 start recovery lease", () => {
  it("keeps a live start and fences a late session create before it can issue a prompt", async () => {
    const ownerId = await seedActiveUser(db);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atHost = new Promise<void>((resolve) => (entered = resolve));
    const delayedHosts: ExecutionHosts = {
      ...hosts,
      async executionFor(runId, options) {
        const execution = await hosts.executionFor(runId, options);

        return {
          ...execution,
          client: {
            ...execution.client,
            async createOwnedSession(...args) {
              const session = await execution.client.createOwnedSession(
                ...args,
              );

              entered();
              await gate;

              return session;
            },
          },
        };
      },
    };
    const sent = await submitOwnerMessage(
      ownerId,
      {
        clientMessageId: randomUUID(),
        body: "recover a slow start",
        subject: null,
      },
      {
        db: db as unknown as Db,
        start: (turnId) => {
          void librarianRuntime.startLibrarianTurn(turnId, {
            db: db as unknown as Db,
            hosts: delayedHosts,
          });

          return Promise.resolve();
        },
      },
    );
    const turnId = sent.turn!.id;

    await atHost;
    await librarianRuntime.startLibrarianTurn(turnId, {
      db: db as unknown as Db,
      hosts,
    });
    let [turn] = rows<{ start_attempts: number }>(
      await db.execute(sql`
        SELECT start_attempts FROM librarian_turns WHERE id = ${turnId}
      `),
    );

    expect(turn.start_attempts).toBe(1);
    expect(await tokenRevoked(turnId)).toBe(false);
    await db.execute(sql`
      UPDATE librarian_turns SET start_lease_at = now() - interval '61 seconds'
      WHERE id = ${turnId}
    `);
    await librarianRuntime.startLibrarianTurn(turnId, {
      db: db as unknown as Db,
      hosts,
    });
    release();
    await settle();
    [turn] = rows<{ start_attempts: number }>(
      await db.execute(sql`
        SELECT start_attempts FROM librarian_turns WHERE id = ${turnId}
      `),
    );
    const createKeys = rows<{ operation_key: string }>(
      await db.execute(sql`
        SELECT create_intent->>'operationKey' AS operation_key
        FROM execution_commands
        WHERE create_intent->'owner'->>'turnId' = ${turnId}
          AND kind = 'session.create'
      `),
    );

    expect(turn.start_attempts).toBe(2);
    expect((await turnRow(turnId)).status).toBe("completed");
    expect(createKeys).toContainEqual({
      operation_key: `librarian-create:${turnId}:2`,
    });
    expect(
      prompts.filter((prompt) => prompt.includes("recover a slow start")),
    ).toHaveLength(1);
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
  async function runner(model: string): Promise<string> {
    const id = `lib-switch-${randomUUID()}`;

    await db.execute(sql`
      INSERT INTO platform_acp_runners
        (id, adapter, capability_agent, model, provider, permission_policy,
         readiness_status, readiness_reasons, enabled)
      VALUES (${id}, 'claude', 'claude', ${model}, '{"kind":"anthropic"}'::jsonb,
        'default', 'Ready', '[]'::jsonb, true)
    `);

    return id;
  }

  async function saveRunner(actorId: string, runnerId: string): Promise<void> {
    await updateLibrarianSettings(
      { enabled: true, runnerId },
      actorId,
      db as unknown as Db,
    );
  }

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

    const actorId = await seedActiveUser(db, { role: "admin" });
    const nextRunnerId = await runner("claude-opus-4-6");
    const memoryId = await rememberPersonalMemory(
      ownerId,
      {
        kind: "preference",
        content: "Keep the switch context",
        scope: "general",
      },
      db as unknown as Db,
    );

    await saveRunner(actorId, nextRunnerId);
    await send(ownerId, "four");
    await settle();
    expect(creates().at(-1)).not.toHaveProperty("resumeSessionId");
    expect(creates().at(-1)).toMatchObject({
      executor: { agent: "claude", model: "claude-opus-4-6" },
      runner: {
        runnerId: nextRunnerId,
        adapter: "claude",
        model: "claude-opus-4-6",
        provider: { kind: "anthropic" },
      },
    });
    expect(prompts.at(-1)).toContain("Conversation so far");
    expect(prompts.at(-1)).toContain("one");
    expect(prompts.at(-1)).toContain("Keep the switch context");
    expect(
      (await listPersonalMemory(ownerId, db as unknown as Db)).items,
    ).toMatchObject([
      { id: memoryId, content: "Keep the switch context", revision: 1 },
    ]);
  });

  it("AV-08 starts a fresh guarded context and masks a derivative reply after project access changes", async () => {
    const contextDb = database.db;
    const ownerId = await seedActiveUser(db);
    const messageProject = await seedProjectRow(db);
    const summaryProject = await seedProjectRow(db);
    const memoryProject = await seedProjectRow(db);

    for (const project of [messageProject, summaryProject, memoryProject]) {
      await addProjectMember(db, {
        projectId: project.id,
        userId: ownerId,
        role: "member",
      });
    }
    const first = await send(ownerId, "Open a general discussion.");

    await settle();
    await contextDb.transaction(async (tx) => {
      const { conversation, segment } = await lockOwnerConversation(
        tx,
        ownerId,
      );

      await appendConversationMessage(tx, {
        conversationId: conversation.id,
        segmentId: segment.id,
        authorKind: "librarian",
        body: "A project-only reply under the legacy capture format.",
        turnId: first.turn!.id,
        sourceProjectIds: [messageProject.id],
      });
      await tx.insert(librarianSegmentSummaries).values({
        segmentId: segment.id,
        revision: 1,
        fromSeq: 1n,
        toSeq: 1n,
        content: {
          decisions: ["Project-only summary."],
          proposals: [],
          uncertainties: [],
        },
        sourceProjectIds: [summaryProject.id],
        forgetGeneration: 0,
        historyGeneration: 0,
      });
    });
    await rememberPersonalMemory(
      ownerId,
      {
        kind: "fact",
        scope: "project",
        projectSlug: memoryProject.slug,
        content: "Project-scoped memory.",
      },
      contextDb,
    );

    reply("The project context informed this answer.");
    const sent = await send(ownerId, "Review the current discussion.");

    await settle();
    expect(creates().at(-1)).not.toHaveProperty("resumeSessionId");
    for (const text of [
      "A project-only reply",
      "Project-only summary.",
      "Project-scoped memory.",
    ])
      expect(prompts.at(-1)).toContain(text);
    const [turn] = await contextDb
      .select({ capture: librarianTurns.knowledgeAccess })
      .from(librarianTurns)
      .where(eq(librarianTurns.id, sent.turn!.id));

    expect(turn.capture?.restrictions).toHaveLength(3);
    expect(turn.capture?.restrictions).toEqual(
      expect.arrayContaining(
        [messageProject, summaryProject, memoryProject].map(({ id }) => ({
          kind: "project_visibility",
          projectId: id,
        })),
      ),
    );
    const responses = await contextDb
      .select()
      .from(librarianMessages)
      .where(
        and(
          eq(librarianMessages.turnId, sent.turn!.id),
          eq(librarianMessages.authorKind, "librarian"),
        ),
      );

    expect(
      await librarianMessageDtos(responses, ownerId, contextDb),
    ).toMatchObject([
      { body: "The project context informed this answer.", masked: false },
    ]);
    await removeProjectMember(db, {
      projectId: messageProject.id,
      userId: ownerId,
    });
    expect(
      await librarianMessageDtos(responses, ownerId, contextDb),
    ).toMatchObject([{ body: null, masked: true }]);
  });

  it("keeps the active response on A and starts its queued successor on saved B exactly once", async () => {
    const actorId = await seedActiveUser(db, { role: "admin" });
    const ownerId = await seedActiveUser(db);
    const runnerA = await runner("claude-sonnet-4-6");
    const runnerB = await runner("claude-opus-4-6");

    await saveRunner(actorId, runnerA);
    const createCount = creates().length;
    const gate = gatedPrompt();
    const first = await send(ownerId, "first switch request");

    await gate.entered;
    let queuedTurnId: string | null = null;

    try {
      const queued = await send(ownerId, "queued switch request");

      queuedTurnId = queued.turn!.id;
      expect(queued.turn).toMatchObject({ status: "queued", queuePosition: 1 });
      await saveRunner(actorId, runnerB);
      expect((await turnRow(first.turn!.id)).status).toBe("running");
      expect(creates()).toHaveLength(createCount + 1);
      expect(creates().at(-1)).toMatchObject({
        runner: { runnerId: runnerA, model: "claude-sonnet-4-6" },
        executor: { agent: "claude", model: "claude-sonnet-4-6" },
      });
    } finally {
      gate.release();
    }
    await settle();
    // The successor runs after commit outside settle(); allow the same bounded
    // integration completion budget as the host-loss queued-successor case.
    await expect
      .poll(async () => (await turnRow(queuedTurnId!)).status, {
        timeout: 20_000,
      })
      .toBe("completed");
    expect(creates()).toHaveLength(createCount + 2);
    expect(creates().at(-1)).toMatchObject({
      runner: { runnerId: runnerB, model: "claude-opus-4-6" },
      executor: { agent: "claude", model: "claude-opus-4-6" },
    });
    expect(creates().at(-1)).not.toHaveProperty("resumeSessionId");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Conversation so far");
    expect(prompts[1]).toContain("first switch request");
    expect(prompts[1]).toContain("queued switch request");
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

    expect(
      messages.filter((message) => message.author_kind === "owner"),
    ).toEqual([
      {
        author_kind: "owner",
        body: "first switch request",
        delivery_state: "processed",
      },
      {
        author_kind: "owner",
        body: "queued switch request",
        delivery_state: "processed",
      },
    ]);
    expect(
      messages.filter((message) => message.author_kind === "librarian"),
    ).toHaveLength(2);
    expect((await turnRow(first.turn!.id)).status).toBe("completed");
  }, 30_000);

  it("uses the updated model and configuration for the same runner id without resuming", async () => {
    const actorId = await seedActiveUser(db, { role: "admin" });
    const ownerId = await seedActiveUser(db);
    const runnerId = await runner("claude-sonnet-4-6");

    await saveRunner(actorId, runnerId);
    await send(ownerId, "retain this conversation");
    await settle();
    await db.execute(sql`
      UPDATE platform_acp_runners
      SET model = 'claude-opus-4-6', env = '{"LIBRARIAN_SWITCH_CONFIG":"updated"}'::jsonb
      WHERE id = ${runnerId}
    `);
    await saveRunner(actorId, runnerId);
    await send(ownerId, "use the updated configuration");
    await settle();
    expect(creates().at(-1)).toMatchObject({
      runner: {
        runnerId,
        model: "claude-opus-4-6",
        env: { LIBRARIAN_SWITCH_CONFIG: "updated" },
      },
      executor: { agent: "claude", model: "claude-opus-4-6" },
    });
    expect(creates().at(-1)).not.toHaveProperty("resumeSessionId");
    expect(prompts).toHaveLength(2);
    expect(prompts.at(-1)).toContain("retain this conversation");
  });

  it("reads saved settings when an already admitted message actually starts", async () => {
    const actorId = await seedActiveUser(db, { role: "admin" });
    const ownerId = await seedActiveUser(db);
    const runnerA = await runner("claude-sonnet-4-6");
    const runnerB = await runner("claude-opus-4-6");

    await saveRunner(actorId, runnerA);
    const admitted = await submitOwnerMessage(
      ownerId,
      {
        clientMessageId: randomUUID(),
        body: "admitted before the switch",
        subject: null,
      },
      { db: db as unknown as Db, start: async () => {} },
    );

    expect(admitted.turn).not.toBeNull();
    await saveRunner(actorId, runnerB);
    await start(admitted.turn!.id);
    await settle();
    expect(creates().at(-1)).toMatchObject({
      runner: { runnerId: runnerB, model: "claude-opus-4-6" },
      executor: { agent: "claude", model: "claude-opus-4-6" },
    });
    expect(prompts).toHaveLength(1);
    expect((await turnRow(admitted.turn!.id)).status).toBe("completed");
  });
});

describe("IT-LMM-07: a summary uses an isolated, tool-free session", () => {
  async function queueSummary(
    ownerId: string,
  ): Promise<{ conversationId: string; turnId: string }> {
    await send(ownerId, "start conversation");
    await settle();
    const { conversation, segment } = await db.transaction((tx) =>
      lockOwnerConversation(tx as never, ownerId),
    );
    const messageId = randomUUID();

    await db.execute(sql`INSERT INTO librarian_messages
      (id, conversation_id, segment_id, seq, author_kind, body, delivery_state)
      VALUES (${messageId}, ${conversation.id}, ${segment.id}, 3,
        'owner', ${"A".repeat(31_000)}, 'processed')`);
    await db.execute(
      sql`UPDATE librarian_conversations SET last_seq = 3 WHERE id = ${conversation.id}`,
    );
    await db.transaction((tx) =>
      queueLibrarianSummary(tx as never, conversation, segment.id),
    );
    const [queued] = rows<{ id: string }>(
      await db.execute(sql`
      SELECT id FROM librarian_turns WHERE segment_id = ${segment.id}
        AND variant = 'summary' AND status = 'queued'
    `),
    );

    expect(queued).toBeDefined();

    return { conversationId: conversation.id, turnId: queued.id };
  }

  it("runs a new session with no token or MCP server and stores structured summary", async () => {
    const ownerId = await seedActiveUser(db);
    const queued = await queueSummary(ownerId);

    reply(
      JSON.stringify({
        decisions: ["Keep the accepted plan"],
        proposals: [],
        uncertainties: [],
      }),
    );
    await admitNextLibrarianTurn(queued.conversationId, {
      db: db as unknown as Db,
      start,
    });
    await settle();
    const payload = creates().at(-1)!;

    expect(payload).not.toHaveProperty("resumeSessionId");
    expect(payload.mcpServers).toEqual([]);
    expect(payload.enforcementProfile).toMatchObject({
      mcps: { allowServers: [] },
      escalationThreshold: 1,
    });
    expect((await turnRow(queued.turnId)).status).toBe("completed");
    const [tokenCount] = rows<{ count: number }>(
      await db.execute(sql`
      SELECT count(*)::int AS count FROM project_tokens
      WHERE librarian_turn_id = ${queued.turnId}
    `),
    );
    const summaries = rows<{ content: { decisions: string[] } }>(
      await db.execute(sql`
      SELECT content FROM librarian_segment_summaries WHERE segment_id =
        (SELECT segment_id FROM librarian_turns WHERE id = ${queued.turnId})
    `),
    );

    expect(tokenCount.count).toBe(0);
    expect(summaries.at(-1)?.content.decisions).toEqual([
      "Keep the accepted plan",
    ]);
  });

  it("IT-EDGE-LAU-04: fails the summary if the adapter reports a tool call", async () => {
    const ownerId = await seedActiveUser(db);
    const queued = await queueSummary(ownerId);

    reply("{}", [
      {
        type: "session.update",
        sessionId: "fake",
        monotonicId: 1,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "forbidden",
          title: "Read",
        },
      } as unknown as SupervisorEvent,
    ]);
    await admitNextLibrarianTurn(queued.conversationId, {
      db: db as unknown as Db,
      start,
    });
    await settle();
    expect(await turnRow(queued.turnId)).toMatchObject({
      status: "failed",
      failure_reason: "capability_trip",
    });
    await expect
      .poll(
        async () => {
          const [row] = rows<{ count: number }>(
            await db.execute(sql`
        SELECT count(*)::int AS count FROM librarian_turns
        WHERE conversation_id = ${queued.conversationId}
          AND variant = 'summary' AND status = 'failed'
      `),
          );

          return row.count;
        },
        { timeout: 20_000 },
      )
      .toBe(2);
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

    expect(
      await clearLibrarianHistory(
        ownerId,
        preview.previewDigest,
        db as unknown as Db,
        hosts,
      ),
    ).toBe("none");
    expect(fake.callsOf("releaseWorkspace")).toHaveLength(releaseCount + 1);
    const [historyCount] = rows<{ count: number }>(
      await db.execute(sql`
      SELECT count(*)::int AS count FROM librarian_messages m
      JOIN librarian_conversations c ON c.id = m.conversation_id
      WHERE c.user_id = ${ownerId}
    `),
    );

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

describe("IT-LOP-03: sweep reconciles interrupted operations before admission", () => {
  it("admits the next owner message after a stale uncommitted operation", async () => {
    const ownerId = await seedActiveUser(db);
    const first = await send(ownerId, "first");

    await settle();
    const [conversation] = rows<{ id: string; current_segment_id: string }>(
      await db.execute(
        sql`SELECT id, current_segment_id FROM librarian_conversations WHERE user_id = ${ownerId}`,
      ),
    );
    const operation = await admitLibrarianOperation(
      {
        conversationId: conversation.id,
        segmentId: conversation.current_segment_id,
        turnId: first.turn!.id,
        idempotencyKey: randomUUID(),
        kind: "task_create",
        target: {},
        body: { title: "never committed" },
        allowDuplicate: false,
      },
      db as unknown as NonNullable<
        Parameters<typeof admitLibrarianOperation>[1]
      >,
    );

    await db.execute(sql`UPDATE librarian_operations
      SET created_at = now() - interval '5 minutes' WHERE id = ${operation.id}`);
    await runLibrarianTurnSweep(db as unknown as Db);
    const [settledOperation] = rows<{ status: string }>(
      await db.execute(
        sql`SELECT status FROM librarian_operations WHERE id = ${operation.id}`,
      ),
    );

    expect(settledOperation.status).toBe("failed");
    const next = await send(ownerId, "second");

    expect(next.turn?.status).not.toBe("queued");
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

describe("IT-ASK-02 private questions survive a suspended turn", () => {
  it("requires the answer controls while parked and lets the owner stop the turn", async () => {
    const { openPrivateQuestion, answerPrivateQuestion } =
      await import("@/lib/librarian/questions");
    const owner = await seedActiveUser(db);
    const gate = gatedPrompt();
    const sent = await send(owner, "Plan checkout");
    const turnId = sent.turn!.id;
    let questionId: string;

    await gate.entered;
    try {
      const [current] = await db
        .select({ tokenId: librarianTurns.tokenId })
        .from(librarianTurns)
        .where(eq(librarianTurns.id, turnId));

      ({ questionId } = await openPrivateQuestion(
        current.tokenId!,
        {
          requestKey: "variant",
          question: "Which checkout variant?",
          schema: {
            schemaVersion: 1,
            fields: [{ name: "variant", type: "string", required: true }],
          },
        },
        db as unknown as Db,
      ));
    } finally {
      gate.release();
    }
    await settle();
    expect(
      await getLibrarianWorkView(owner, db as unknown as Db),
    ).toMatchObject({
      activeTurn: { id: turnId, status: "awaiting_answer" },
      queuedMessages: [],
    });
    await expect(send(owner, "Use mobile")).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "question_awaiting_answer" },
    });
    expect(await stopLibrarianTurn(owner, db as unknown as Db)).toEqual({
      turnId,
    });
    expect((await turnRow(turnId)).status).toBe("stopped");
    expect((await conversationState(owner)).run_status).toBe("NeedsInputIdle");
    await expect(
      answerPrivateQuestion(
        owner,
        questionId,
        { variant: "mobile" },
        db as unknown as Db,
      ),
    ).rejects.toMatchObject({ details: { reason: "question_closed" } });
  });

  it("a segment reset closes an undelivered question without creating any project work", async () => {
    const { openPrivateQuestion, answerPrivateQuestion } =
      await import("@/lib/librarian/questions");
    const { requestLibrarianReset } = await import("@/lib/librarian/reset");
    const ownerId = await seedActiveUser(db);
    const gate = gatedPrompt();
    const projectWorkCounts = async () =>
      rows(
        await db.execute(sql`
      SELECT (SELECT count(*) FROM assignments) AS assignments,
        (SELECT count(*) FROM tasks) AS tasks,
        (SELECT count(*) FROM hitl_requests) AS requests`),
      );
    const before = await projectWorkCounts();
    const { turn } = await send(ownerId, "Design a second journey");

    await gate.entered;
    let questionId: string;

    try {
      const [current] = await db
        .select()
        .from(librarianTurns)
        .where(eq(librarianTurns.id, turn!.id));

      ({ questionId } = await openPrivateQuestion(
        current.tokenId!,
        {
          requestKey: "which",
          question: "Which screen?",
          schema: {
            schemaVersion: 1,
            fields: [{ name: "screen", type: "string", required: true }],
          },
        },
        db as unknown as Db,
      ));
    } finally {
      gate.release();
    }
    await settle();
    expect(await requestLibrarianReset(ownerId, db as unknown as Db)).toBe(
      "none",
    );
    await expect(
      answerPrivateQuestion(
        ownerId,
        questionId,
        { screen: "old" },
        db as unknown as Db,
      ),
    ).rejects.toMatchObject({ details: { reason: "question_closed" } });
    expect(await projectWorkCounts()).toEqual(before);
  });

  it("parks a question, accepts one answer and resumes the same turn under a fresh worker", async () => {
    const { openPrivateQuestion, answerPrivateQuestion } =
      await import("@/lib/librarian/questions");
    const owner = await seedActiveUser(db);
    const stranger = await seedActiveUser(db);
    const gate = gatedPrompt();
    const sent = await send(owner, "Design the customer journey.");
    const turnId = sent.turn!.id;
    const request = {
      requestKey: "choose",
      question: "Which page?",
      schema: {
        schemaVersion: 1 as const,
        fields: [
          {
            name: "page",
            type: "string" as const,
            required: true,
            options: ["Cart"],
          },
        ],
      },
    };

    await gate.entered;
    const [original] = rows<{ assignment_id: string }>(
      await db.execute(
        sql`SELECT r.execution_assignment_id AS assignment_id FROM runs r JOIN librarian_conversations c ON c.run_id=r.id WHERE c.id=${sent.message.conversationId}`,
      ),
    );
    let id: string;

    try {
      const [turn] = await db
        .select()
        .from(librarianTurns)
        .where(eq(librarianTurns.id, turnId));
      const { POST } =
        await import("@/app/api/v1/ext/librarian/human-asks/route");
      const servers = creates().at(-1)!.mcpServers as {
        env: Record<string, string>;
      }[];
      const token = servers[0].env.MAISTER_PROJECT_TOKEN;
      const invoke = (bearer: string, body: unknown) =>
        POST(
          new Request("http://localhost/api/v1/ext/librarian/human-asks", {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        );

      expect((await invoke("invalid", request)).status).toBe(401);
      expect((await invoke(token, { ...request, turnId })).status).toBe(422);
      expect(
        (await invoke(token, { ...request, question: "q".repeat(65536) }))
          .status,
      ).toBe(413);
      const response = await invoke(token, request);

      expect(response.status).toBe(202);
      const opened = await response.json();

      expect(opened.state).toBe("checkpoint_pending");
      id = opened.questionId;
      expect(
        await openPrivateQuestion(turn.tokenId!, request, db as unknown as Db),
      ).toEqual(opened);
      await expect(
        openPrivateQuestion(
          turn.tokenId!,
          { ...request, question: "Changed?" },
          db as unknown as Db,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await db.execute(
        sql`UPDATE project_tokens SET expires_at=now()-interval '1 second' WHERE id=${turn.tokenId}`,
      );
      expect(
        (await invoke(token, { ...request, requestKey: "expired" })).status,
      ).toBe(401);
    } finally {
      gate.release();
    }
    await settle();
    expect((await turnRow(turnId)).status).toBe("awaiting_answer");
    await expect(
      answerPrivateQuestion(
        stranger,
        id,
        { page: "custom" },
        db as unknown as Db,
      ),
    ).rejects.toMatchObject({ details: { reason: "not_found" } });
    await expect(
      answerPrivateQuestion(owner, id, {}, db as unknown as Db),
    ).rejects.toMatchObject({ code: "CONFIG" });
    const accepted = await answerPrivateQuestion(
      owner,
      id,
      { page: "custom" },
      db as unknown as Db,
    );

    expect(accepted.state).toBe("accepted");
    expect(
      await answerPrivateQuestion(
        owner,
        id,
        { page: "custom" },
        db as unknown as Db,
      ),
    ).toEqual(accepted);
    await expect(
      answerPrivateQuestion(owner, id, { page: "other" }, db as unknown as Db),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await admitNextLibrarianTurn(sent.message.conversationId, {
      db: db as unknown as Db,
      start: (turnId) =>
        librarianRuntime.startLibrarianTurn(turnId, {
          db: db as unknown as Db,
          hosts: {
            ...hosts,
            executionFor: async () => {
              throw new MaisterError("EXECUTOR_UNAVAILABLE", "Host offline");
            },
          },
        }),
    });
    await settle();
    expect((await turnRow(turnId)).status).toBe("queued");
    expect((await conversationState(owner)).run_status).toBe("NeedsInputIdle");
    expect(
      await answerPrivateQuestion(
        owner,
        id,
        { page: "custom" },
        db as unknown as Db,
      ),
    ).toEqual(accepted);
    const resumed = gatedPrompt();

    await admitNextLibrarianTurn(sent.message.conversationId, {
      db: db as unknown as Db,
      start,
    });
    await resumed.entered;
    try {
      expect(
        await librarianRuntime.endLibrarianTurn(
          db as unknown as Db,
          turnId,
          { status: "failed", reason: "deadline" },
          ["running"],
          original.assignment_id,
        ),
      ).toBe(false);
      expect((await turnRow(turnId)).status).toBe("running");
    } finally {
      resumed.release();
    }
    await settle();
    expect((await turnRow(turnId)).status).toBe("completed");
    expect(
      prompts.filter((prompt) => prompt.includes('"page":"custom"')),
    ).toHaveLength(1);
    expect(
      await answerPrivateQuestion(
        owner,
        id,
        { page: "custom" },
        db as unknown as Db,
      ),
    ).toMatchObject({ state: "delivered" });
  });
});
