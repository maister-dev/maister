// M30 (ADR-078): gate-chat turns against a real DB + real git worktree with
// an injected fake supervisor API. Pins:
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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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
import { resolveDirtyWorktree } from "@/lib/runs/dirty-resolution";
import {
  GATE_CHAT_READONLY_PREAMBLE,
  sendGateChatTurn,
} from "@/lib/services/gate-chat";

const schema = fullSchema as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

let container: StartedPostgreSqlContainer;
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
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_gate_chat")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

type FakeApiOpts = {
  // Invoked DURING the prompt turn (simulates the agent touching files).
  mutateDuringTurn?: () => Promise<void>;
  replyText?: string;
};

function makeFakeApi(opts: FakeApiOpts = {}) {
  const sendPromptCalls: Array<{
    sessionId: string;
    stepId: string;
    prompt: string;
    readOnlyTurn?: boolean;
  }> = [];
  const createSessionCalls: Array<Record<string, unknown>> = [];
  let liveRunId = "";

  const api = {
    listSessions: vi.fn(async () => [
      {
        sessionId: "sup-live",
        runId: liveRunId,
        projectSlug: "x",
        stepId: "implement",
        status: "live" as const,
        pid: 1,
        startedAt: new Date().toISOString(),
        logPath: "/tmp/x.log",
        monotonicId: 1,
        acpSessionId: "acp-1",
      },
    ]),
    sendPrompt: vi.fn(
      async (
        sessionId: string,
        input: { stepId: string; prompt: string; readOnlyTurn?: boolean },
      ) => {
        sendPromptCalls.push({ sessionId, ...input });
        await opts.mutateDuringTurn?.();

        return { stopReason: "end_turn" as const };
      },
    ),
    createSession: vi.fn(async (input: Record<string, unknown>) => {
      createSessionCalls.push(input);

      return {
        sessionId: "sup-resumed",
        pid: 2,
        acpSessionId: (input.resumeSessionId as string) ?? "acp-new",
      };
    }),

    streamSession: async function* (_sessionId: string) {
      yield {
        type: "session.update" as const,
        sessionId: "sup-live",
        monotonicId: 10,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: opts.replyText ?? "the answer" },
        },
      };
    },
    setLiveRunId: (id: string) => {
      liveRunId = id;
    },
    sendPromptCalls,
    createSessionCalls,
  };

  return api;
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
    manifest: { schemaVersion: 1, name: "GC", steps: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: opts.runStatus ?? "NeedsInput",
    currentStepId: "review",
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

async function runRow(runId: string) {
  const r = await pool.query(
    `SELECT status, keepalive_until FROM runs WHERE id = $1`,
    [runId],
  );

  return r.rows[0] as { status: string; keepalive_until: Date | null };
}

describe("sendGateChatTurn — live (DD3)", () => {
  it("persists both turns, tags the prompt, never resolves the HITL, bumps keepalive", async () => {
    const { runId, hitlId } = await seedChatPause();
    const api = makeFakeApi({ replyText: "because X mirrors Y" });

    api.setLiveRunId(runId);

    const out = await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "why did you choose X?",
      actorLabel: "Reviewer",
      db,
      api: api as never,
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

    const run = await runRow(runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.keepalive_until).not.toBeNull();

    const hitl = (
      await pool.query(`SELECT responded_at FROM hitl_requests WHERE id = $1`, [
        hitlId,
      ])
    ).rows[0];

    expect(hitl.responded_at).toBeNull();
  }, 60_000);

  it("chat input is sent verbatim (never Mustache-evaluated)", async () => {
    const { runId, hitlId } = await seedChatPause();
    const api = makeFakeApi();

    api.setLiveRunId(runId);

    const msg = "what does {{ task.prompt }} resolve to?";

    await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: msg,
      db,
      api: api as never,
    });

    expect(api.sendPromptCalls[0].prompt).toContain(msg);
  }, 60_000);
});

describe("sendGateChatTurn — idle chat-resume (DD3)", () => {
  it("respawns with resumeSessionId, flips Idle→NeedsInput (never Running), no runner drive", async () => {
    const { runId, hitlId } = await seedChatPause({
      runStatus: "NeedsInputIdle",
    });
    const api = makeFakeApi();

    api.setLiveRunId(""); // no live session — idle path

    const out = await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "still there?",
      db,
      api: api as never,
    });

    expect(out.resumed).toBe(true);
    expect(api.createSessionCalls).toHaveLength(1);
    expect(api.createSessionCalls[0].resumeSessionId).toBe("acp-1");
    expect(api.sendPromptCalls[0].sessionId).toBe("sup-resumed");

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
        api: makeFakeApi() as never,
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
          api: makeFakeApi() as never,
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
        api: makeFakeApi() as never,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

describe("sendGateChatTurn — L3 mutation sensor (DD11)", () => {
  it("captures ONE first-turn baseline, reverts a mutated turn to it, flags the row", async () => {
    const seeded = await seedChatPause();
    const { runId, hitlId, worktree, repo } = seeded;

    // Turn 1: clean — anchors the baseline.
    const api1 = makeFakeApi();

    api1.setLiveRunId(runId);
    await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "q1",
      db,
      api: api1 as never,
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
    const api2 = makeFakeApi({
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
      api: api2 as never,
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

    const api = makeFakeApi();

    api.setLiveRunId(runId);

    await expect(
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: "hi",
        db,
        api: api as never,
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT" });

    expect(await chatRows(hitlId)).toHaveLength(0);
    expect(api.sendPromptCalls).toHaveLength(0);
  }, 60_000);

  it("a dirty-resolution between turns re-anchors the baseline (no false un-discard)", async () => {
    const { runId, hitlId, worktree, repo } = await seedChatPause();
    const api = makeFakeApi();

    api.setLiveRunId(runId);

    // Turn 1 anchors the baseline WITH wip.txt present (untracked).
    await writeFile(join(worktree, "wip.txt"), "reviewer-visible wip\n");
    await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "q1",
      db,
      api: api as never,
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
      api: api as never,
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

describe("sendGateChatTurn — idle claim-before-spawn (X-2PC)", () => {
  beforeEach(() => {
    stateSpies.markResumed.mockClear();
    stateSpies.rollbackResumedRun.mockClear();
  });

  it("a lost markResumed claim refuses with CONFLICT and never spawns a duplicate session", async () => {
    const { runId, hitlId } = await seedChatPause({
      runStatus: "NeedsInputIdle",
    });
    const fake = makeFakeApi();

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
        api: fake as never,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(fake.createSessionCalls).toHaveLength(0);
    expect(fake.sendPromptCalls).toHaveLength(0);
    // The rival owns the resume — the run stays where the rival put it.
    expect((await runRow(runId)).status).toBe("NeedsInput");

    // The question persisted before the refusal (documented crash-window
    // shape: a visible question without an answer row — re-ask once live).
    const rows = await chatRows(hitlId);

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("user");
  }, 60_000);

  it("a failed respawn rolls the claim back to NeedsInputIdle and prompts nothing", async () => {
    const { runId, hitlId } = await seedChatPause({
      runStatus: "NeedsInputIdle",
    });
    const fake = makeFakeApi();

    fake.createSession.mockRejectedValueOnce(
      new MaisterError("ACP_PROTOCOL", "supervisor down"),
    );

    await expect(
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: "still there?",
        api: fake as never,
      }),
    ).rejects.toMatchObject({ code: "ACP_PROTOCOL" });

    expect(stateSpies.rollbackResumedRun).toHaveBeenCalledTimes(1);
    expect((await runRow(runId)).status).toBe("NeedsInputIdle");
    expect(fake.sendPromptCalls).toHaveLength(0);
  }, 60_000);

  it("the happy idle path claims BEFORE spawning (order pinned)", async () => {
    const { runId, hitlId } = await seedChatPause({
      runStatus: "NeedsInputIdle",
    });
    const fake = makeFakeApi();

    const out = await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "why this approach?",
      api: fake as never,
    });

    expect(out.resumed).toBe(true);

    const claimOrder = stateSpies.markResumed.mock.invocationCallOrder.at(-1);
    const spawnOrder = fake.createSession.mock.invocationCallOrder.at(-1);

    expect(claimOrder).toBeDefined();
    expect(spawnOrder).toBeDefined();
    expect(claimOrder!).toBeLessThan(spawnOrder!);
  }, 60_000);
});

describe("sendGateChatTurn — deferred-release + live-path idempotency (ADR-078)", () => {
  it("releases the stream consumer when the prompt fails and persists no agent row (X-DEFER)", async () => {
    const { runId, hitlId } = await seedChatPause();

    let consumerReleased = false;
    const sendPrompt = vi.fn(async () => {
      throw new MaisterError("ACP_PROTOCOL", "supervisor refused the prompt");
    });
    const api = {
      listSessions: vi.fn(async () => [
        {
          sessionId: "sup-live",
          runId,
          projectSlug: "x",
          stepId: "review",
          status: "live" as const,
          pid: 1,
          startedAt: new Date().toISOString(),
          logPath: "/tmp/x.log",
          monotonicId: 1,
          acpSessionId: "acp-1",
        },
      ]),
      sendPrompt,
      createSession: vi.fn(),
      // Ends ONLY when the service aborts the deferred. If the prompt-failure
      // path forgot to release it, `await consumer` would hang and time out.
      streamSession: async function* (
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
      },
    };

    await expect(
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: "why X?",
        db,
        api: api as never,
      }),
    ).rejects.toMatchObject({ code: "ACP_PROTOCOL" });

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(consumerReleased).toBe(true);

    // The user turn persisted before the side-effect; no agent row after.
    const rows = await chatRows(hitlId);

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("user");
  }, 60_000);

  it("serializes concurrent live turns: no duplicate seq, a lost race is CONFLICT", async () => {
    const { runId, hitlId } = await seedChatPause();
    const api = makeFakeApi();

    api.setLiveRunId(runId);

    // Establish the L3 baseline + seqs 1/2 once so the racers below skip
    // checkpoint capture and contend purely on the UNIQUE(hitl_request_id, seq)
    // insert.
    await sendGateChatTurn({
      runId,
      hitlRequestId: hitlId,
      message: "baseline",
      db,
      api: api as never,
    });

    const racers = Array.from({ length: 8 }, (_, i) =>
      sendGateChatTurn({
        runId,
        hitlRequestId: hitlId,
        message: `concurrent ${i}`,
        db,
        api: api as never,
      }),
    );
    const results = await Promise.allSettled(racers);

    // Every lost race is a clean CONFLICT (never a raw 23505 / 500), and at
    // least one turn wins.
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(MaisterError);
        expect((r.reason as MaisterError).code).toBe("CONFLICT");
      }
    }

    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    // The constraint held: no two persisted rows share a seq.
    const rows = await chatRows(hitlId);
    const seqs = rows.map((r) => r.seq);

    expect(new Set(seqs).size).toBe(seqs.length);
  }, 90_000);
});
