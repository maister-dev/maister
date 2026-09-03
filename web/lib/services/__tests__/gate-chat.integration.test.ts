// M30 (ADR-078): gate-chat turns against a real DB + real git worktree with
// a fake local execution host (ADR-166) scripting the agent session. Pins:
//   - live turn: user+agent rows (seq), L1 preamble + readOnlyTurn on the
//     prompt, gate-chat-<hitlId> stepId, keepalive bump, HITL stays open,
//     status stays NeedsInput;
//   - idle turn: chat-resume respawns with resumeSessionId, Idle→NeedsInput
//     (NEVER →Running), no runner re-drive;
//   - DD2 refusals (permission kind / HumanWorking / no session / Running);
//   - L3: ONE first-turn baseline; a mutated turn restores to it and flags
//     mutation_reverted; the baseline is reused (not re-captured); a missing
//     worktree fails CLOSED (turn refused, nothing persisted);
//   - a dirty-resolution between turns deletes the baseline; the next turn
//     re-anchors fresh and never un-discards the reviewer's Discard.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { MaisterError } from "@/lib/errors";
import {
  releaseAssignmentForRun,
  type SupervisorEvent,
} from "@/lib/execution-host";
import { type Db as ExecutionDb } from "@/lib/execution-host/db";
import { captureCheckpoint } from "@/lib/flows/graph/workspace-checkpoint";
import { resolveDirtyWorktree } from "@/lib/runs/dirty-resolution";
import {
  GATE_CHAT_TURN_LEASE_MS,
  GATE_CHAT_READONLY_PREAMBLE,
  recoverExpiredGateChatTurns,
  requireNoLiveGateChatTurn,
  sendGateChatTurn,
} from "@/lib/services/gate-chat";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// Delegating spies over the resume claim: every test runs the REAL
// transitions by default; the claim-race test layers a one-shot rival on top.
const stateSpies = vi.hoisted(() => ({
  markResumed: vi.fn(),
  rollbackResumedRun: vi.fn(),
}));

vi.mock("@/lib/runs/state-transitions", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;

  return {
    ...real,
    markResumed: (...a: unknown[]) => stateSpies.markResumed(...a),
    rollbackResumedRun: (...a: unknown[]) =>
      stateSpies.rollbackResumedRun(...a),
  };
});

let realTransitions: typeof import("@/lib/runs/state-transitions");

beforeAll(async () => {
  realTransitions = await vi.importActual("@/lib/runs/state-transitions");
  stateSpies.markResumed.mockImplementation(realTransitions.markResumed);
  stateSpies.rollbackResumedRun.mockImplementation(
    realTransitions.rollbackResumedRun,
  );
});

const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test_gate_chat",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-166: claim transitions mint on the local host — a fake host backs
  // every implicit resolution in this process.
  await fakeExecutionHosts(db);
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

type FakeApiOpts = {
  // Invoked DURING the prompt turn (simulates the agent touching files).
  mutateDuringTurn?: () => Promise<void>;
  replyText?: string;
  // Mints the run's `launch` assignment (a driven run's shape); `checkpointed`
  // releases it the way the keep-alive checkpoint leaves an idle run.
  runId?: string;
  checkpointed?: boolean;
  // Re-script a host from an earlier turn of the same run (the assignment is
  // bound to that host's identity).
  fake?: FakeExecutionHost;
};

type SentPrompt = {
  sessionId: string;
  stepId: string;
  prompt: string;
  readOnlyTurn?: boolean;
  assignmentEpoch: number;
};

// A fake local host per case, registered as THE local host so every implicit
// `createExecutionHosts({ db })` and claim mint reaches it. The agent replies
// with `replyText` on the session stream during the prompt turn.
async function scriptHost(opts: FakeApiOpts = {}) {
  const fake = opts.fake ?? createFakeExecutionHost();
  const sendPromptCalls: SentPrompt[] = [];

  await fakeExecutionHosts(db, { fake, runId: opts.runId });
  if (opts.checkpointed && opts.runId) {
    await releaseAssignmentForRun(
      db as unknown as ExecutionDb,
      opts.runId,
      "checkpointed",
    );
  }
  fake.setPromptBehavior(async (ctx) => {
    const { stepId, prompt, readOnlyTurn } = ctx.envelope.payload;

    sendPromptCalls.push({
      sessionId: ctx.sessionId,
      stepId,
      prompt,
      readOnlyTurn,
      assignmentEpoch: ctx.envelope.fence.assignmentEpoch,
    });
    fake.pushEvent(ctx.sessionId, {
      type: "session.update",
      sessionId: ctx.sessionId,
      monotonicId: 10,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: opts.replyText ?? "the answer" },
      },
    } as SupervisorEvent);
    await opts.mutateDuringTurn?.();

    return { stopReason: "end_turn", meta: null };
  });

  return {
    fake,
    sendPromptCalls,
    get createSessionCalls() {
      return fake
        .callsOf("createSession")
        .map((call) => call.envelope?.payload as Record<string, unknown>);
    },
    createdSessionIds() {
      return fake
        .callsOf("createSession")
        .map(
          (call) =>
            fake.receipts.get(call.envelope!.command.id)?.body
              .sessionId as string,
        );
    },
    // The driver's live session for the run — none when `runId` is empty.
    setLiveRunId(runId: string) {
      fake.sessions.clear();
      if (!runId) return;
      fake.sessions.set("sup-live", {
        sessionId: "sup-live",
        runId,
        stepId: "implement",
        acpSessionId: "acp-1",
        executionWorkspaceId: "ws-live",
        assignmentEpoch: 1,
        createdByCommandId: "seed",
        status: "live",
      });
    },
  };
}

async function seedChatPause(
  opts: {
    runStatus?: string;
    hitlKind?: string;
    acpSessionId?: string | null;
  } = {},
): Promise<{
  runId: string;
  hitlId: string;
  worktree: string;
  repo: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const hitlId = randomUUID();

  const repo = await mkdtemp(join(tmpdir(), "maister-gc-parent-"));
  const wtRoot = await mkdtemp(join(tmpdir(), "maister-gc-wt-"));

  createdPaths.push(repo, wtRoot);

  const worktree = join(wtRoot, runId);
  const branch = `maister/${runId.slice(0, 8)}`;

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t.local");
  await git(repo, "config", "user.name", "T");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: repo,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "gc",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/gc",
    manifest: {
      schemaVersion: 1,
      name: "GC",
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(crypto.randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowVersion: "v1.0.0",
    status: opts.runStatus ?? "NeedsInput",
    currentStepId: "review",
  });
  // M42 (ADR-114): runner identity + resume handle live on run_sessions.
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    acpSessionId: opts.acpSessionId === undefined ? "acp-1" : opts.acpSessionId,
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch,
    worktreePath: worktree,
    parentRepoPath: repo,
    baseBranch: "main",
  });
  await db.insert(schema.hitlRequests).values({
    id: hitlId,
    runId,
    stepId: "review",
    kind: opts.hitlKind ?? "human",
    schema: { review: true },
    prompt: "Review?",
  });

  return { runId, hitlId, worktree, repo };
}

async function chatRows(hitlId: string) {
  const r = await pool.query(
    `SELECT role, body, seq, mutation_reverted FROM gate_chat_messages
      WHERE hitl_request_id = $1 ORDER BY seq`,
    [hitlId],
  );

  return r.rows as Array<{
    role: string;
    body: string;
    seq: number;
    mutation_reverted: boolean;
  }>;
}

async function chatTurnRows(hitlId: string) {
  const result = await pool.query(
    `SELECT state, lease_expires_at, agent_message_id, error_code
      FROM gate_chat_turns WHERE hitl_request_id = $1 ORDER BY created_at`,
    [hitlId],
  );

  return result.rows as Array<{
    state: string;
    lease_expires_at: Date | null;
    agent_message_id: string | null;
    error_code: string | null;
  }>;
}

async function runRow(runId: string) {
  const r = await pool.query(
    `SELECT status, keepalive_until FROM runs WHERE id = $1`,
    [runId],
  );

  return r.rows[0] as { status: string; keepalive_until: Date | null };
}

async function assignmentRows(runId: string) {
  const result = await pool.query(
    `SELECT epoch, state, placement_reason, released_reason
       FROM execution_assignments WHERE run_id = $1 ORDER BY epoch`,
    [runId],
  );

  return (
    result.rows as Array<{
      epoch: number;
      state: string;
      placement_reason: string;
      released_reason: string | null;
    }>
  ).map((row) => ({
    epoch: row.epoch,
    state: row.state,
    placementReason: row.placement_reason,
    releasedReason: row.released_reason,
  }));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor: condition not met");
}

describe("sendGateChatTurn — live (DD3)", () => {
  it("persists both turns, tags the prompt, never resolves the HITL, bumps keepalive", async () => {
    const { runId, hitlId } = await seedChatPause();
    const api = await scriptHost({ replyText: "because X mirrors Y", runId });

    api.setLiveRunId(runId);

    const out = await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "why did you choose X?",
      actorLabel: "Reviewer",
      db,
    });

    expect(out.resumed).toBe(false);
    expect(out.agentMessage.body).toContain("because X mirrors Y");

    const rows = await chatRows(hitlId);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      role: "user",
      body: "why did you choose X?",
      seq: 1,
    });
    expect(rows[1]).toMatchObject({ role: "agent", seq: 2 });

    // DD4 marker + L1 preamble + L2 flag on the wire.
    expect(api.sendPromptCalls).toHaveLength(1);
    expect(api.sendPromptCalls[0].sessionId).toBe("sup-live");
    expect(api.sendPromptCalls[0].stepId).toBe(`gate-chat-${hitlId}`);
    expect(
      api.sendPromptCalls[0].prompt.startsWith(GATE_CHAT_READONLY_PREAMBLE),
    ).toBe(true);
    expect(api.sendPromptCalls[0].prompt).toContain("why did you choose X?");
    expect(api.sendPromptCalls[0].readOnlyTurn).toBe(true);
    // Q5 (ADR-166): a live turn rides the run's ACTIVE assignment — no new
    // generation is minted and the prompt carries its epoch.
    expect(api.sendPromptCalls[0].assignmentEpoch).toBe(1);
    expect(await assignmentRows(runId)).toEqual([
      {
        epoch: 1,
        state: "active",
        placementReason: "launch",
        releasedReason: null,
      },
    ]);

    const run = await runRow(runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.keepalive_until).not.toBeNull();

    const hitl = (
      await pool.query(`SELECT responded_at FROM hitl_requests WHERE id = $1`, [
        hitlId,
      ])
    ).rows[0];

    expect(hitl.responded_at).toBeNull();

    expect(await chatTurnRows(hitlId)).toEqual([
      expect.objectContaining({
        state: "completed",
        lease_expires_at: null,
        agent_message_id: out.agentMessage.id,
        error_code: null,
      }),
    ]);
  }, 60_000);

  it("chat input is sent verbatim (never Mustache-evaluated)", async () => {
    const { runId, hitlId } = await seedChatPause();
    const api = await scriptHost({ runId });

    api.setLiveRunId(runId);

    const msg = "what does {{ task.prompt }} resolve to?";

    await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: msg,
      db,
    });

    expect(api.sendPromptCalls[0].prompt).toContain(msg);
  }, 60_000);
});

describe("sendGateChatTurn — idle chat-resume (DD3)", () => {
  it("respawns with resumeSessionId, flips Idle→NeedsInput (never Running), no runner drive", async () => {
    const { runId, hitlId } = await seedChatPause({
      runStatus: "NeedsInputIdle",
    });
    const api = await scriptHost({ runId, checkpointed: true });

    api.setLiveRunId(""); // no live session — idle path

    const out = await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "still there?",
      db,
    });

    expect(out.resumed).toBe(true);
    expect(api.createSessionCalls).toHaveLength(1);
    expect(api.createSessionCalls[0].resumeSessionId).toBe("acp-1");
    expect(api.sendPromptCalls[0].sessionId).toBe(api.createdSessionIds()[0]);
    // Q5 (ADR-166): the chat-resume is a NEW driver generation minted as
    // `gate_chat` over the checkpoint-released launch generation; the spawn
    // and the prompt carry its epoch and the adopted workspace handle.
    expect(await assignmentRows(runId)).toEqual([
      {
        epoch: 1,
        state: "released",
        placementReason: "launch",
        releasedReason: "checkpointed",
      },
      {
        epoch: 2,
        state: "active",
        placementReason: "gate_chat",
        releasedReason: null,
      },
    ]);
    expect(typeof api.createSessionCalls[0].executionWorkspaceId).toBe(
      "string",
    );
    expect(api.sendPromptCalls[0].assignmentEpoch).toBe(2);

    const run = await runRow(runId);

    // The allow-list invariant: Idle→NeedsInput is permitted, →Running NEVER.
    expect(run.status).toBe("NeedsInput");
  }, 60_000);
});

describe("sendGateChatTurn — DD2 refusals", () => {
  it("refuses a permission-kind pause", async () => {
    const { runId, hitlId } = await seedChatPause({ hitlKind: "permission" });

    await expect(
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: "hi",
        db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("refuses HumanWorking and Running", async () => {
    for (const runStatus of ["HumanWorking", "Running"]) {
      const { runId, hitlId } = await seedChatPause({ runStatus });

      await expect(
        sendGateChatTurn({
          runId,
          hitlRequestId: hitlId,
          message: "hi",
          db,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION" });
    }
  });

  it("refuses when the run has no acp_session_id (empty state)", async () => {
    const { runId, hitlId } = await seedChatPause({ acpSessionId: null });

    await expect(
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: "hi",
        db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

describe("sendGateChatTurn — L3 mutation sensor (DD11)", () => {
  it("captures ONE first-turn baseline, reverts a mutated turn to it, flags the row", async () => {
    const seeded = await seedChatPause();
    const { runId, hitlId, worktree, repo } = seeded;

    // Turn 1: clean — anchors the baseline.
    const api1 = await scriptHost({ runId });

    api1.setLiveRunId(runId);
    await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "q1",
      db,
    });

    const refList = await git(
      repo,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      `refs/maister/chat-checkpoints/${runId}`,
    );

    expect(refList).toContain(
      `refs/maister/chat-checkpoints/${runId}/${hitlId}`,
    );

    const baselineSha = refList.trim().split(" ")[1];

    // Turn 2: the agent mutates the worktree during the turn.
    const api2 = await scriptHost({
      fake: api1.fake,
      runId,
      mutateDuringTurn: async () => {
        await writeFile(join(worktree, "rogue.txt"), "should not survive\n");
        await writeFile(join(worktree, "base.txt"), "tampered\n");
      },
    });

    api2.setLiveRunId(runId);

    const out = await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "q2",
      db,
    });

    expect(out.agentMessage.mutationReverted).toBe(true);

    // Workspace restored to the FIRST-turn baseline.
    const status = await git(worktree, "status", "--porcelain");

    expect(status).not.toContain("rogue.txt");

    const baseContent = await execFileAsync("cat", [
      join(worktree, "base.txt"),
    ]);

    expect(baseContent.stdout).toBe("base\n");

    // The baseline was REUSED, not re-captured.
    const refList2 = await git(
      repo,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      `refs/maister/chat-checkpoints/${runId}`,
    );

    expect(refList2.trim().split(" ")[1]).toBe(baselineSha);

    const rows = await chatRows(hitlId);
    const agentRows = rows.filter((r) => r.role === "agent");

    expect(agentRows[0].mutation_reverted).toBe(false);
    expect(agentRows[1].mutation_reverted).toBe(true);
  }, 60_000);

  it("fails CLOSED when the worktree cannot be sensed (no rows persisted)", async () => {
    const { runId, hitlId, worktree } = await seedChatPause();

    await rm(worktree, { recursive: true, force: true });

    const api = await scriptHost({ runId });

    api.setLiveRunId(runId);

    await expect(
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: "hi",
        db,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT" });

    expect(await chatRows(hitlId)).toHaveLength(0);
    expect(api.sendPromptCalls).toHaveLength(0);
  }, 60_000);

  it("a dirty-resolution between turns re-anchors the baseline (no false un-discard)", async () => {
    const { runId, hitlId, worktree, repo } = await seedChatPause();
    const api = await scriptHost({ runId });

    api.setLiveRunId(runId);

    // Turn 1 anchors the baseline WITH wip.txt present (untracked).
    await writeFile(join(worktree, "wip.txt"), "reviewer-visible wip\n");
    await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "q1",
      db,
    });

    const sha1 = (
      await git(
        repo,
        "for-each-ref",
        "--format=%(objectname)",
        `refs/maister/chat-checkpoints/${runId}`,
      )
    ).trim();

    // The reviewer explicitly discards — wip.txt is removed and the chat
    // baseline ref is deleted (ADR-082 → deleteChatCheckpoint).
    await resolveDirtyWorktree({
      runId,
      hitlRequestId: hitlId,
      choice: "discard",
      db,
      rematerialize: async () => undefined,
    });

    // Turn 2 re-anchors fresh; the discarded file must NOT come back.
    await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "q2",
      db,
    });

    const sha2 = (
      await git(
        repo,
        "for-each-ref",
        "--format=%(objectname)",
        `refs/maister/chat-checkpoints/${runId}`,
      )
    ).trim();

    expect(sha2).not.toBe(sha1);

    const status = await git(worktree, "status", "--porcelain");

    expect(status).not.toContain("wip.txt");
  }, 60_000);
});

describe("recoverExpiredGateChatTurns — process-restart fence", () => {
  it("cancels a persisted expired prompt, restores L3, then releases the response fence", async () => {
    const { runId, hitlId, worktree } = await seedChatPause();

    await captureCheckpoint({
      worktreePath: worktree,
      namespace: "chat-checkpoints",
      runId,
      id: hitlId,
    });
    await writeFile(join(worktree, "rogue-after-crash.txt"), "rogue\n");

    const userRows = await db
      .insert(schema.gateChatMessages)
      .values({
        runId,
        hitlRequestId: hitlId,
        nodeId: "review",
        gateAttempt: 1,
        role: "user",
        authorUserId: null,
        authorLabel: "Reviewer",
        body: "Why did the process stop?",
        acpSessionId: "acp-1",
        seq: 1,
      })
      .returning({ id: schema.gateChatMessages.id });
    const user = userRows[0];

    if (!user) throw new Error("test user message was not written");

    await db.insert(schema.gateChatTurns).values({
      runId,
      hitlRequestId: hitlId,
      userMessageId: user.id,
      state: "pending",
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });

    const { fake } = await scriptHost({ runId });
    const recovered = await recoverExpiredGateChatTurns({
      db,
      sessions: [
        {
          sessionId: "sup-live",
          runId,
          projectSlug: "x",
          stepId: "review",
          status: "live",
          pid: 1,
          startedAt: new Date().toISOString(),
          monotonicId: 1,
          acpSessionId: "acp-1",
        },
      ],
    });

    expect(recovered).toBe(1);
    expect(fake.callsOf("cancelPrompt").map((call) => call.args[0])).toEqual([
      "sup-live",
    ]);
    await expect(
      readFile(join(worktree, "rogue-after-crash.txt")),
    ).rejects.toThrow();
    expect(await chatTurnRows(hitlId)).toEqual([
      expect.objectContaining({
        state: "aborted",
        lease_expires_at: null,
        agent_message_id: null,
        error_code: "LEASE_EXPIRED",
      }),
    ]);
    await expect(
      db.transaction((tx: NodePgDatabase) =>
        requireNoLiveGateChatTurn(tx, hitlId),
      ),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("rejects a terminal coordinator that cannot identify a complete outcome", async () => {
    const { runId, hitlId } = await seedChatPause();
    const userRows = await db
      .insert(schema.gateChatMessages)
      .values({
        runId,
        hitlRequestId: hitlId,
        nodeId: "review",
        gateAttempt: 1,
        role: "user",
        authorUserId: null,
        authorLabel: "Reviewer",
        body: "Question with an invalid terminal outcome",
        acpSessionId: "acp-1",
        seq: 1,
      })
      .returning({ id: schema.gateChatMessages.id });
    const user = userRows[0];

    if (!user) throw new Error("test user message was not written");

    await expect(
      db.insert(schema.gateChatTurns).values({
        runId,
        hitlRequestId: hitlId,
        userMessageId: user.id,
        state: "completed",
      }),
    ).rejects.toThrow();
  });
});

describe("sendGateChatTurn — idle claim-before-spawn (X-2PC)", () => {
  beforeEach(() => {
    stateSpies.markResumed.mockClear();
    stateSpies.rollbackResumedRun.mockClear();
  });

  it("a lost markResumed claim refuses with CONFLICT and never spawns a duplicate session", async () => {
    const { runId, hitlId } = await seedChatPause({
      runStatus: "NeedsInputIdle",
    });
    const api = await scriptHost({ runId, checkpointed: true });

    // A rival /respond resume lands inside the load→claim window: the real
    // claim runs twice — the rival's first call wins, this turn's own claim
    // loses the CAS.
    stateSpies.markResumed.mockImplementationOnce(async (...a: unknown[]) => {
      const rival = await realTransitions.markResumed(
        a[0] as string,
        a[1] as never,
      );

      expect(rival.ok).toBe(true);

      return realTransitions.markResumed(a[0] as string, a[1] as never);
    });

    await expect(
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: "did you cover the retry path?",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(api.createSessionCalls).toHaveLength(0);
    expect(api.sendPromptCalls).toHaveLength(0);
    // The rival owns the resume — the run stays where the rival put it.
    expect((await runRow(runId)).status).toBe("NeedsInput");

    // The question persisted before the refusal (documented crash-window
    // shape: a visible question without an answer row — re-ask once live).
    const rows = await chatRows(hitlId);

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("user");
    expect(await chatTurnRows(hitlId)).toEqual([
      expect.objectContaining({
        state: "failed",
        lease_expires_at: null,
        agent_message_id: null,
        error_code: "ACP_PROTOCOL",
      }),
    ]);
  }, 60_000);

  it("a failed respawn rolls the claim back to NeedsInputIdle and prompts nothing", async () => {
    const { runId, hitlId } = await seedChatPause({
      runStatus: "NeedsInputIdle",
    });
    const api = await scriptHost({ runId, checkpointed: true });

    api.fake.failOnce(
      "createSession",
      new MaisterError("ACP_PROTOCOL", "supervisor down"),
    );

    await expect(
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: "still there?",
      }),
    ).rejects.toMatchObject({ code: "ACP_PROTOCOL" });

    expect(stateSpies.rollbackResumedRun).toHaveBeenCalledTimes(1);
    expect((await runRow(runId)).status).toBe("NeedsInputIdle");
    expect(api.sendPromptCalls).toHaveLength(0);
    // ADR-166: the rollback releases the `gate_chat` generation it minted.
    expect(await assignmentRows(runId)).toEqual([
      {
        epoch: 1,
        state: "released",
        placementReason: "launch",
        releasedReason: "checkpointed",
      },
      {
        epoch: 2,
        state: "released",
        placementReason: "gate_chat",
        releasedReason: "resume_rollback",
      },
    ]);
  }, 60_000);

  it("the happy idle path claims BEFORE spawning (order pinned)", async () => {
    const { runId, hitlId } = await seedChatPause({
      runStatus: "NeedsInputIdle",
    });
    const api = await scriptHost({ runId, checkpointed: true });
    let claimsBeforeSpawn = -1;

    api.fake.onCall("createSession", () => {
      claimsBeforeSpawn = stateSpies.markResumed.mock.calls.length;
    });

    const out = await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "why this approach?",
    });

    expect(out.resumed).toBe(true);
    expect(api.createSessionCalls).toHaveLength(1);
    expect(claimsBeforeSpawn).toBe(1);
  }, 60_000);
});

describe("sendGateChatTurn — deferred-release + live-path idempotency (ADR-078)", () => {
  it("keeps the rework fence until a lease-expired prompt is cancelled and L3 has restored", async () => {
    const { runId, hitlId, worktree } = await seedChatPause();
    const api = await scriptHost({ runId });
    const realNow = Date.now;
    const nowSpy = vi.spyOn(Date, "now");
    let expiredFenceError: unknown;

    api.setLiveRunId(runId);
    // The lease expires while the host lists the run's sessions.
    api.fake.onCall("listSessions", async () => {
      nowSpy.mockReturnValue(realNow() + GATE_CHAT_TURN_LEASE_MS + 1);
      await pool.query(
        `UPDATE gate_chat_turns
           SET lease_expires_at = to_timestamp(0)
         WHERE hitl_request_id = $1 AND state = 'pending'`,
        [hitlId],
      );
      try {
        await db.transaction(async (tx) => {
          await requireNoLiveGateChatTurn(tx, hitlId);
        });
      } catch (err) {
        expiredFenceError = err;
      }
    });
    api.fake.setPromptBehavior(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await writeFile(join(worktree, "rogue-after-expiry.txt"), "rogue\n");

      return { stopReason: "cancelled", meta: null };
    });

    try {
      await expect(
        sendGateChatTurn({
          runId,
          hitlRequestId: hitlId,
          message: "why this branch?",
          db,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION" });

      await waitFor(() => api.fake.callsOf("cancelPrompt").length > 0);
      expect(
        api.fake.callsOf("cancelPrompt").map((call) => call.args[0]),
      ).toEqual(["sup-live"]);
      expect(expiredFenceError).toMatchObject({ code: "PRECONDITION" });
      await expect(
        readFile(join(worktree, "rogue-after-expiry.txt")),
      ).rejects.toThrow();
      expect(await chatRows(hitlId)).toHaveLength(1);
      expect(await chatTurnRows(hitlId)).toEqual([
        expect.objectContaining({
          state: "aborted",
          lease_expires_at: null,
          agent_message_id: null,
          error_code: "LEASE_EXPIRED",
        }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  }, 60_000);

  it("releases the stream consumer when the prompt fails and persists no agent row (X-DEFER)", async () => {
    const { runId, hitlId } = await seedChatPause();
    const api = await scriptHost({ runId });

    let consumerReleased = false;

    api.setLiveRunId(runId);
    api.fake.setPromptBehavior(async () => {
      throw new MaisterError("ACP_PROTOCOL", "supervisor refused the prompt");
    });
    // Ends ONLY when the service aborts the deferred. If the prompt-failure
    // path forgot to release it, `await consumer` would hang and time out.
    api.fake.transport.streamSession = async function* (
      _sid: string,
      opts?: { signal?: AbortSignal },
    ) {
      const signal = opts?.signal;

      try {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();

            return;
          }

          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        consumerReleased = true;
      }
    };

    await expect(
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: "why X?",
        db,
      }),
    ).rejects.toMatchObject({ code: "ACP_PROTOCOL" });

    expect(api.fake.callsOf("sendPrompt")).toHaveLength(1);
    expect(consumerReleased).toBe(true);

    // The user turn persisted before the side-effect; no agent row after.
    const rows = await chatRows(hitlId);

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("user");
  }, 60_000);

  it("serializes concurrent live turns through one pending coordinator", async () => {
    const { runId, hitlId } = await seedChatPause();
    const api = await scriptHost({ runId });

    api.setLiveRunId(runId);

    // Establish the L3 baseline + seqs 1/2 once so the racers below skip
    // checkpoint capture and contend purely on the UNIQUE(hitl_request_id, seq)
    // insert.
    await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "baseline",
      db,
    });

    const racers = Array.from({ length: 8 }, (_, i) =>
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: `concurrent ${i}`,
        db,
      }),
    );
    const results = await Promise.allSettled(racers);

    // A second reviewer sees the durable pending turn rather than a raw unique
    // violation or a second prompt. At least one turn wins.
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(MaisterError);
        expect((r.reason as MaisterError).code).toBe("PRECONDITION");
      }
    }

    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    // The constraint held: no two persisted rows share a seq.
    const rows = await chatRows(hitlId);
    const seqs = rows.map((r) => r.seq);

    expect(new Set(seqs).size).toBe(seqs.length);
  }, 90_000);
});
