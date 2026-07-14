import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { and, eq, lte, sql } from "drizzle-orm";
import pino from "pino";

import { runnerSupervisorInput } from "@/lib/acp-runners/spawn-intent";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  applyWorkspacePolicy,
  captureCheckpoint,
  checkpointRefName,
} from "@/lib/flows/graph/workspace-checkpoint";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import {
  bumpKeepalive,
  markResumed,
  rollbackResumedRun,
} from "@/lib/runs/state-transitions";
import {
  createSession as defaultCreateSession,
  listSessions as defaultListSessions,
  sendPrompt as defaultSendPrompt,
  streamSession as defaultStreamSession,
  type SupervisorEvent,
} from "@/lib/supervisor-client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  gateChatMessages,
  gateChatTurns,
  hitlRequests,
  projects,
  runs,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "gate-chat",
  level: process.env.LOG_LEVEL ?? "info",
});

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

// The coordinator lease must outlive the bounded supervisor handoff and leave
// enough recovery room for the post-prompt transcript write. It is deliberately
// server-owned: clients cannot extend an in-flight turn by retrying requests.
export const GATE_CHAT_TURN_LEASE_MS = 180_000;

type GateChatTurnState = "pending" | "completed" | "failed" | "aborted";

type GateChatTurnRow = {
  id: string;
  state: GateChatTurnState;
  leaseExpiresAt: Date | null;
};

// M30 (ADR-078 L1): the instruct layer — server-side constant prepended to
// every chat prompt, never user text. L2/L3 back it up.
export const GATE_CHAT_READONLY_PREAMBLE =
  "You are answering a reviewer's question at a review pause. This is a " +
  "READ-ONLY Q&A turn: do NOT modify, create, move, or delete any file in " +
  "the workspace, do not run commands that write, and do not commit. " +
  "Reading files to ground your answer is fine.\n\n";

// M30 (ADR-078 DD4): server-derived stepId marker — dash, never a colon
// (supervisor SAFE_PATH_SEGMENT); also names the per-step log file.
export function gateChatStepId(hitlRequestId: string): string {
  return `gate-chat-${hitlRequestId}`;
}

// A concurrent turn at the same pause raced this one onto the same
// UNIQUE(hitl_request_id, seq) slot. Surface it as CONFLICT instead of leaking
// the raw Postgres 23505 — the loser re-asks once the transcript settles.
function rethrowSeqConflict(err: unknown): never {
  if ((err as { code?: unknown } | null)?.code === "23505") {
    throw new MaisterError(
      "CONFLICT",
      "concurrent gate-chat turn in progress for this pause — retry once it settles",
      { cause: err instanceof Error ? err : undefined },
    );
  }

  throw err;
}

// M30 (ADR-078 DD2): session-presence-driven, answer-only availability.
export function gateChatAvailability(input: {
  runStatus: string;
  hitlKind: string | null;
  hitlResponse?: unknown;
  hitlRespondedAt: Date | null;
  acpSessionId: string | null;
}): { available: boolean; reason?: string } {
  if (
    input.runStatus !== "NeedsInput" &&
    input.runStatus !== "NeedsInputIdle"
  ) {
    return {
      available: false,
      reason: `run not paused at a gate (status=${input.runStatus})`,
    };
  }
  if (input.hitlKind !== "human" && input.hitlKind !== "form") {
    return {
      available: false,
      reason: `chat is available at human/form pauses only (kind=${input.hitlKind ?? "none"})`,
    };
  }
  if (input.hitlRespondedAt !== null) {
    return { available: false, reason: "the pause already resolved" };
  }
  if (input.hitlResponse !== null && input.hitlResponse !== undefined) {
    return {
      available: false,
      reason: "the pause response is being delivered",
    };
  }
  if (!input.acpSessionId) {
    return {
      available: false,
      reason: "no agent session to ask — the run has no resumable session",
    };
  }

  return { available: true };
}

function turnLeaseExpiresAt(now: Date): Date {
  return new Date(now.getTime() + GATE_CHAT_TURN_LEASE_MS);
}

// This helper is intentionally called while the HITL row is already locked.
// Both response claim and chat admission take locks hitl_request → turn, which
// makes a response and a long-running ACP prompt mutually fenceable without
// ever retaining a database transaction during the prompt.
export async function abortExpiredGateChatTurns(
  tx: Db,
  hitlRequestId: string,
  now = new Date(),
): Promise<number> {
  const rows = await tx
    .update(gateChatTurns)
    .set({
      state: "aborted",
      leaseExpiresAt: null,
      completedAt: now,
      errorCode: "LEASE_EXPIRED",
    })
    .where(
      and(
        eq(gateChatTurns.hitlRequestId, hitlRequestId),
        eq(gateChatTurns.state, "pending"),
        lte(gateChatTurns.leaseExpiresAt, now),
      ),
    )
    .returning({ id: gateChatTurns.id });

  return rows.length;
}

export async function requireNoLiveGateChatTurn(
  tx: Db,
  hitlRequestId: string,
): Promise<void> {
  const expiredCount = await abortExpiredGateChatTurns(tx, hitlRequestId);
  const rows = (await tx
    .select({
      id: gateChatTurns.id,
      state: gateChatTurns.state,
      leaseExpiresAt: gateChatTurns.leaseExpiresAt,
    })
    .from(gateChatTurns)
    .where(
      and(
        eq(gateChatTurns.hitlRequestId, hitlRequestId),
        eq(gateChatTurns.state, "pending"),
      ),
    )
    .for("update")) as GateChatTurnRow[];

  if (rows[0]) {
    throw new MaisterError(
      "PRECONDITION",
      "a gate-chat turn is still in progress; retry after it completes",
    );
  }

  if (expiredCount > 0) {
    log.info(
      { hitlRequestId, expiredCount },
      "[gate-chat] expired turns aborted before response/admission",
    );
  }
}

async function failGateChatTurn(args: {
  db: Db;
  turnId: string;
  hitlRequestId: string;
  errorCode: string;
}): Promise<void> {
  await args.db.transaction(async (tx: Db) => {
    const hitlRows = await tx
      .select({
        response: hitlRequests.response,
        respondedAt: hitlRequests.respondedAt,
      })
      .from(hitlRequests)
      .where(eq(hitlRequests.id, args.hitlRequestId))
      .for("update");
    const hitl = hitlRows[0];
    const turnRows = await tx
      .select({ id: gateChatTurns.id, state: gateChatTurns.state })
      .from(gateChatTurns)
      .where(eq(gateChatTurns.id, args.turnId))
      .for("update");
    const turn = turnRows[0];

    if (!turn || turn.state !== "pending") return;

    const isClaimed =
      !hitl || hitl.response !== null || hitl.respondedAt !== null;
    await tx
      .update(gateChatTurns)
      .set({
        state: isClaimed ? "aborted" : "failed",
        leaseExpiresAt: null,
        completedAt: new Date(),
        errorCode: args.errorCode,
      })
      .where(eq(gateChatTurns.id, args.turnId));
  });
}

export type GateChatSupervisorApi = {
  listSessions: typeof defaultListSessions;
  sendPrompt: typeof defaultSendPrompt;
  createSession: typeof defaultCreateSession;
  streamSession: typeof defaultStreamSession;
};

const defaultApi: GateChatSupervisorApi = {
  listSessions: defaultListSessions,
  sendPrompt: defaultSendPrompt,
  createSession: defaultCreateSession,
  streamSession: defaultStreamSession,
};

export interface GateChatMessageView {
  id: string;
  role: "user" | "agent";
  authorLabel: string;
  body: string;
  seq: number;
  mutationReverted: boolean;
  createdAt: Date;
}

export async function listGateChatMessages(args: {
  runId: string;
  hitlRequestId: string;
  db?: Db;
}): Promise<GateChatMessageView[]> {
  const d = args.db ?? getDb();

  const rows = await d
    .select({
      id: gateChatMessages.id,
      role: gateChatMessages.role,
      authorLabel: gateChatMessages.authorLabel,
      body: gateChatMessages.body,
      seq: gateChatMessages.seq,
      mutationReverted: gateChatMessages.mutationReverted,
      createdAt: gateChatMessages.createdAt,
    })
    .from(gateChatMessages)
    .where(
      and(
        eq(gateChatMessages.runId, args.runId),
        eq(gateChatMessages.hitlRequestId, args.hitlRequestId),
      ),
    )
    .orderBy(gateChatMessages.seq);

  return rows as GateChatMessageView[];
}

async function git(
  worktreePath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: env ?? process.env,
      },
    );

    return stdout;
  } catch (err) {
    throw new MaisterError(
      "CHECKPOINT",
      `git ${args[0]} failed in ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

// Tree SHA of the CURRENT worktree content (tracked + untracked, ignored
// excluded) via a temp index — the L3 comparison probe. Same mechanism as
// captureCheckpoint, without writing a ref.
async function currentContentTree(worktreePath: string): Promise<string> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "maister-l3-probe-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: path.join(tmpDir, "index"),
  };

  try {
    await git(worktreePath, ["add", "-A"], env);

    return (await git(worktreePath, ["write-tree"], env)).trim();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function treePaths(
  worktreePath: string,
  tree: string,
): Promise<Set<string>> {
  const out = await git(worktreePath, ["ls-tree", "-r", "--name-only", tree]);

  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

// M30 (ADR-078 L3): the hard neutrality guarantee. Compares the current
// worktree content (tree probe + branch tip) against the first-turn
// baseline; on a delta restores the baseline (ADR-079 rewind overlay) and
// deletes ONLY the rogue untracked paths absent from the baseline tree —
// never a blanket clean, never `.maister/`. Fail-closed: a sensor that
// cannot sense throws CHECKPOINT.
async function senseAndRestore(args: {
  worktreePath: string;
  baselineRef: string;
}): Promise<{ reverted: boolean }> {
  const baselineSha = (
    await git(args.worktreePath, [
      "rev-parse",
      "--verify",
      `${args.baselineRef}^{commit}`,
    ])
  ).trim();
  const baselineTree = (
    await git(args.worktreePath, ["rev-parse", `${baselineSha}^{tree}`])
  ).trim();
  const baselineTip = (
    await git(args.worktreePath, ["rev-parse", `${baselineSha}^`])
  ).trim();

  const currentTip = (
    await git(args.worktreePath, ["rev-parse", "HEAD"])
  ).trim();
  const currentTree = await currentContentTree(args.worktreePath);

  if (currentTree === baselineTree && currentTip === baselineTip) {
    return { reverted: false };
  }

  // Rogue untracked paths: present in the current content, absent from the
  // baseline tree. Computed BEFORE the restore (the rewind overlay leaves
  // attempt-created untracked files in place by design — DD6).
  const currentPaths = await treePaths(args.worktreePath, currentTree);
  const baselinePaths = await treePaths(args.worktreePath, baselineSha);
  const rogue = [...currentPaths].filter((p) => !baselinePaths.has(p));

  await applyWorkspacePolicy({
    policy: "rewind-to-node-checkpoint",
    worktreePath: args.worktreePath,
    checkpointRef: args.baselineRef,
  });

  for (const rel of rogue) {
    const abs = path.resolve(args.worktreePath, rel);

    // Path containment: the restore never reaches outside the worktree.
    if (!abs.startsWith(path.resolve(args.worktreePath) + path.sep)) continue;
    await rm(abs, { force: true });
  }

  log.warn(
    { worktreePath: args.worktreePath, rogueCount: rogue.length },
    "[neutrality] reverted mutation",
  );

  return { reverted: true };
}

export interface SendGateChatTurnResult {
  userMessage: GateChatMessageView;
  agentMessage: GateChatMessageView & { mutationReverted: boolean };
  resumed: boolean;
}

// M30 (ADR-078): one answer-only chat turn. Order of operations (X-2PC):
//   1. server-state load + DD2 availability guard
//   2. L3 baseline ensure (fail-closed BEFORE any persist)
//   3. persist the user row (intent)
//   4. live → prompt the live session; idle → chat-resume (markResumed claim
//      Idle→NeedsInput BEFORE the respawn with session/resume — a lost claim
//      is CONFLICT, a failed spawn rolls the claim back) then prompt
//   5. L3 sense + restore
//   6. persist the agent row (+ mutation_reverted) — the turn marker AFTER
//      the side-effect
// Chat NEVER resolves the HITL and NEVER drives →Running. Crash windows: a
// crash after (3) leaves a question without an answer row (visible, re-ask);
// after (4)/(5) the reply is lost but the workspace is restored — re-ask.
export async function sendGateChatTurn(args: {
  runId: string;
  hitlRequestId: string;
  message: string;
  actorUserId?: string | null;
  actorLabel?: string;
  db?: Db;
  api?: GateChatSupervisorApi;
}): Promise<SendGateChatTurnResult> {
  const d = args.db ?? getDb();
  const api = args.api ?? defaultApi;

  if (typeof args.message !== "string" || args.message.trim() === "") {
    throw new MaisterError("CONFIG", "chat message must be a non-empty string");
  }

  const [runRows, hitlRows, workspaceRows] = await Promise.all([
    d.select().from(runs).where(eq(runs.id, args.runId)),
    d
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, args.hitlRequestId)),
    d.select().from(workspaces).where(eq(workspaces.runId, args.runId)),
  ]);
  const baseRun = runRows[0];
  const hitl = hitlRows[0];
  const workspace = workspaceRows[0];

  if (!baseRun) {
    throw new MaisterError("PRECONDITION", `run not found: ${args.runId}`);
  }

  // M42 (ADR-114): the resume handle + runner snapshot come from the run's
  // ACTIVE session (run_sessions), not the dropped runs columns. A multi-session
  // run delivers the turn to the active (paused) session.
  const activeSession = await loadActiveRunSession(d, args.runId);
  const run = {
    ...baseRun,
    acpSessionId: activeSession?.acpSessionId ?? null,
    runnerSnapshot: activeSession?.runnerSnapshot ?? null,
  };
  const activeAcpSessionId = run.acpSessionId;

  // X-IDENT: both ids are url-params; the hitl row must belong to the run.
  if (!hitl || hitl.runId !== args.runId) {
    throw new MaisterError(
      "PRECONDITION",
      `hitl request ${args.hitlRequestId} not found for run ${args.runId}`,
    );
  }

  const availability = gateChatAvailability({
    runStatus: run.status,
    hitlKind: hitl.kind,
    hitlResponse: hitl.response,
    hitlRespondedAt: hitl.respondedAt,
    acpSessionId: activeAcpSessionId,
  });

  if (!availability.available) {
    throw new MaisterError(
      "PRECONDITION",
      `gate-chat unavailable: ${availability.reason}`,
    );
  }
  if (!workspace || workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace missing/removed for run ${args.runId}`,
    );
  }

  const projectRows = await d
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const projectSlug: string = projectRows[0]?.slug ?? "unknown";

  // (2) L3 baseline — ONE per pause, anchored to the FIRST turn, reused on
  // every later turn. Fail-closed: capture/verify failure refuses the turn.
  const baselineRef = checkpointRefName(
    "chat-checkpoints",
    args.runId,
    args.hitlRequestId,
  );
  const baselineExists = await execFileAsync(
    "git",
    [
      "-C",
      workspace.worktreePath,
      "rev-parse",
      "--verify",
      `${baselineRef}^{commit}`,
    ],
    { timeout: GIT_TIMEOUT_MS },
  ).then(
    () => true,
    () => false,
  );

  if (!baselineExists) {
    try {
      await captureCheckpoint({
        worktreePath: workspace.worktreePath,
        namespace: "chat-checkpoints",
        runId: args.runId,
        id: args.hitlRequestId,
      });
    } catch (err) {
      throw new MaisterError(
        "CHECKPOINT",
        `gate-chat refused — the L3 neutrality baseline cannot be captured: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }

  // (3) Admission is a short transaction. It locks the exact HITL row shared
  // with response claim, reaps an expired abandoned prompt, then persists the
  // user transcript row and its pending coordinator together. Nothing below
  // this point holds a database transaction across ACP.
  const userLabel = args.actorLabel ?? "user";
  let admitted: {
    turnId: string;
    nodeId: string;
    gateAttempt: number;
    userMessage: GateChatMessageView;
  };

  try {
    admitted = await d.transaction(async (tx: Db) => {
      const lockedHitlRows = await tx
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.id, args.hitlRequestId))
        .for("update");
      const lockedHitl = lockedHitlRows[0];
      const lockedRunRows = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, args.runId))
        .for("update");
      const lockedRun = lockedRunRows[0];

      if (!lockedRun || !lockedHitl || lockedHitl.runId !== args.runId) {
        throw new MaisterError(
          "PRECONDITION",
          "gate-chat source is no longer available",
        );
      }

      const lockedAvailability = gateChatAvailability({
        runStatus: lockedRun.status,
        hitlKind: lockedHitl.kind,
        hitlResponse: lockedHitl.response,
        hitlRespondedAt: lockedHitl.respondedAt,
        acpSessionId: activeAcpSessionId,
      });

      if (!lockedAvailability.available) {
        throw new MaisterError(
          "PRECONDITION",
          `gate-chat unavailable: ${lockedAvailability.reason}`,
        );
      }

      await requireNoLiveGateChatTurn(tx, args.hitlRequestId);

      const gateAttempt =
        typeof (lockedHitl.schema as { gateAttempt?: unknown } | null)
          ?.gateAttempt === "number"
          ? (lockedHitl.schema as { gateAttempt: number }).gateAttempt
          : 1;
      const seqRows = await tx
        .select({ max: sql<number>`coalesce(max(${gateChatMessages.seq}), 0)` })
        .from(gateChatMessages)
        .where(eq(gateChatMessages.hitlRequestId, args.hitlRequestId));
      const baseSeq = Number(seqRows[0]?.max ?? 0);
      const insertedUserRows = await tx
        .insert(gateChatMessages)
        .values({
          runId: args.runId,
          hitlRequestId: args.hitlRequestId,
          nodeId: lockedHitl.stepId,
          gateAttempt,
          role: "user",
          authorUserId: args.actorUserId ?? null,
          authorLabel: userLabel,
          body: args.message,
          acpSessionId: activeAcpSessionId,
          seq: baseSeq + 1,
        })
        .returning({
          id: gateChatMessages.id,
          createdAt: gateChatMessages.createdAt,
        });
      const userMessage = insertedUserRows[0];

      if (!userMessage) {
        throw new MaisterError(
          "PRECONDITION",
          "gate-chat user turn was not written",
        );
      }

      const turnRows = await tx
        .insert(gateChatTurns)
        .values({
          runId: args.runId,
          hitlRequestId: args.hitlRequestId,
          userMessageId: userMessage.id,
          state: "pending",
          leaseExpiresAt: turnLeaseExpiresAt(new Date()),
        })
        .returning({ id: gateChatTurns.id });
      const turn = turnRows[0];

      if (!turn) {
        throw new MaisterError(
          "PRECONDITION",
          "gate-chat turn was not admitted",
        );
      }

      return {
        turnId: turn.id,
        nodeId: lockedHitl.stepId,
        gateAttempt,
        userMessage: {
          id: userMessage.id,
          role: "user" as const,
          authorLabel: userLabel,
          body: args.message,
          seq: baseSeq + 1,
          mutationReverted: false,
          createdAt: userMessage.createdAt,
        },
      };
    });
  } catch (err) {
    // The partial unique index is a final backstop if an application-level
    // transaction is bypassed or a future writer forgets the HITL row lock.
    rethrowSeqConflict(err);
  }

  // (4) resolve the session: live (NeedsInput) vs chat-resume (Idle).
  const stepId = gateChatStepId(args.hitlRequestId);
  let supervisorSessionId: string;
  let resumed = false;

  try {
    if (run.status === "NeedsInput") {
      const sessions = await api.listSessions();
      const live = sessions.find(
        (s) => s.runId === args.runId && s.status === "live",
      );

      if (live) {
        supervisorSessionId = live.sessionId;
      } else {
        // The pause says live but no session exists (crash window) — treat as
        // idle-style resume rather than refusing the reviewer.
        supervisorSessionId = await chatResume();
      }
    } else {
      supervisorSessionId = await chatResume();
    }
  } catch (err) {
    await failGateChatTurn({
      db: d,
      turnId: admitted.turnId,
      hitlRequestId: args.hitlRequestId,
      errorCode: "ACP_PROTOCOL",
    });
    throw err;
  }

  async function chatResume(): Promise<string> {
    // DD3: respawn + ACP session/resume on the stored handle. MUST NOT call
    // the resumed-session driver and MUST NOT touch the hitl row — the run
    // re-idles via the sweeper.
    // Claim BEFORE spawn (same order as resumeRun): a concurrent /respond
    // resume or second chat turn serializes on the markResumed CAS — the
    // loser must not spawn a duplicate supervisor session or prompt a pause
    // it no longer owns.
    const idleClaim = run.status === "NeedsInputIdle";

    if (idleClaim) {
      const claim = await markResumed(args.runId, { db: d });

      if (!claim.ok) {
        throw new MaisterError(
          "CONFLICT",
          "concurrent resume in progress for this run — retry once it settles",
        );
      }
    }

    let created: { sessionId: string };

    try {
      created = await api.createSession({
        runId: args.runId,
        projectSlug,
        worktreePath: workspace.worktreePath,
        stepId,
        executor: {
          agent: (run.runnerSnapshot?.capabilityAgent ?? "claude") as
            | "claude"
            | "codex",
          model: run.runnerSnapshot?.model ?? "unknown",
          router: run.runnerSnapshot?.sidecarId ? "ccr" : undefined,
        },
        runner: run.runnerSnapshot
          ? runnerSupervisorInput({ snapshot: run.runnerSnapshot })
          : undefined,
        resumeSessionId: activeAcpSessionId as string,
      });
    } catch (err) {
      if (idleClaim) {
        try {
          await rollbackResumedRun(args.runId, { db: d });
          log.warn(
            { runId: args.runId, hitlRequestId: args.hitlRequestId },
            "[gate-chat] spawn failed — resume claim rolled back to NeedsInputIdle",
          );
        } catch (rollbackErr) {
          log.warn(
            {
              runId: args.runId,
              err:
                rollbackErr instanceof Error
                  ? rollbackErr.message
                  : String(rollbackErr),
            },
            "[gate-chat] resume-claim rollback failed",
          );
        }
      }
      throw err;
    }

    resumed = true;
    log.info(
      { runId: args.runId, hitlRequestId: args.hitlRequestId },
      "[gate-chat] idle resume (~$0.28 respawn)",
    );

    return created.sessionId;
  }

  // (4b) prompt — L1 preamble + verbatim reviewer text (NEVER templated),
  // L2 readOnlyTurn flag, DD4 stepId marker. Reply text accumulates from the
  // session stream (chat_turn event preferred, chunks as fallback).
  let replyFromEvent: string | null = null;
  let replyChunks = "";
  const abort = new AbortController();
  const consumer = (async () => {
    try {
      for await (const ev of api.streamSession(supervisorSessionId, {
        signal: abort.signal,
      }) as AsyncGenerator<SupervisorEvent>) {
        if (
          ev.type === "session.chat_turn" &&
          ev.hitlRequestId === args.hitlRequestId &&
          ev.role === "agent"
        ) {
          replyFromEvent = ev.body;
        }
        if (ev.type === "session.update") {
          const update = ev.update as {
            sessionUpdate?: string;
            content?: { type?: string; text?: string };
          } | null;

          if (
            update?.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" &&
            typeof update.content.text === "string"
          ) {
            replyChunks += update.content.text;
          }
        }
        if (ev.type === "session.exited" || ev.type === "session.crashed") {
          break;
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        log.warn(
          { runId: args.runId, err: (err as Error).message },
          "[gate-chat] stream consumer error",
        );
      }
    }
  })();

  try {
    await api.sendPrompt(supervisorSessionId, {
      stepId,
      prompt: GATE_CHAT_READONLY_PREAMBLE + args.message,
      readOnlyTurn: true,
    });
  } catch (err) {
    // X-DEFER: release the stream consumer on EVERY failure path.
    abort.abort();
    await consumer;
    await failGateChatTurn({
      db: d,
      turnId: admitted.turnId,
      hitlRequestId: args.hitlRequestId,
      errorCode: "ACP_PROTOCOL",
    });
    throw new MaisterError(
      "ACP_PROTOCOL",
      `gate-chat prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  abort.abort();
  await consumer;

  let sensed: { reverted: boolean };

  try {
    // The pause stays warm while the reviewer is asking questions.
    await bumpKeepalive(args.runId, { db: d });

    // (5) L3 sense + restore — unconditional, fail-closed.
    sensed = await senseAndRestore({
      worktreePath: workspace.worktreePath,
      baselineRef,
    });
  } catch (err) {
    await failGateChatTurn({
      db: d,
      turnId: admitted.turnId,
      hitlRequestId: args.hitlRequestId,
      errorCode: err instanceof MaisterError ? err.code : "CHECKPOINT",
    });
    throw err;
  }

  // (6) persist the agent turn and mark the coordinator completed in one
  // transaction. A response that won after an expired lease causes an abort;
  // the late ACP reply is deliberately dropped.
  const replyBody = replyFromEvent ?? replyChunks;
  let agentMessage: GateChatMessageView & { mutationReverted: boolean };

  try {
    agentMessage = await d.transaction(async (tx: Db) => {
      const lockedHitlRows = await tx
        .select({
          response: hitlRequests.response,
          respondedAt: hitlRequests.respondedAt,
        })
        .from(hitlRequests)
        .where(eq(hitlRequests.id, args.hitlRequestId))
        .for("update");
      const lockedHitl = lockedHitlRows[0];
      const turnRows = await tx
        .select({ id: gateChatTurns.id, state: gateChatTurns.state })
        .from(gateChatTurns)
        .where(eq(gateChatTurns.id, admitted.turnId))
        .for("update");
      const turn = turnRows[0];

      if (
        !turn ||
        turn.state !== "pending" ||
        !lockedHitl ||
        lockedHitl.response !== null ||
        lockedHitl.respondedAt !== null
      ) {
        if (turn?.state === "pending") {
          await tx
            .update(gateChatTurns)
            .set({
              state: "aborted",
              leaseExpiresAt: null,
              completedAt: new Date(),
              errorCode: "RESPONSE_CLAIMED",
            })
            .where(eq(gateChatTurns.id, turn.id));
        }
        throw new MaisterError(
          "PRECONDITION",
          "gate-chat turn became stale before its agent reply could be stored",
        );
      }

      const agentRows = await tx
        .insert(gateChatMessages)
        .values({
          runId: args.runId,
          hitlRequestId: args.hitlRequestId,
          nodeId: admitted.nodeId,
          gateAttempt: admitted.gateAttempt,
          role: "agent",
          authorUserId: null,
          authorLabel: "agent",
          body: replyBody,
          acpSessionId: activeAcpSessionId,
          seq: admitted.userMessage.seq + 1,
          mutationReverted: sensed.reverted,
        })
        .returning({
          id: gateChatMessages.id,
          createdAt: gateChatMessages.createdAt,
        });
      const storedAgent = agentRows[0];

      if (!storedAgent) {
        throw new MaisterError(
          "PRECONDITION",
          "gate-chat agent turn was not written",
        );
      }

      await tx
        .update(gateChatTurns)
        .set({
          state: "completed",
          agentMessageId: storedAgent.id,
          leaseExpiresAt: null,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(gateChatTurns.id, admitted.turnId),
            eq(gateChatTurns.state, "pending"),
          ),
        );

      return {
        id: storedAgent.id,
        role: "agent" as const,
        authorLabel: "agent",
        body: replyBody,
        seq: admitted.userMessage.seq + 1,
        mutationReverted: sensed.reverted,
        createdAt: storedAgent.createdAt,
      };
    });
  } catch (err) {
    await failGateChatTurn({
      db: d,
      turnId: admitted.turnId,
      hitlRequestId: args.hitlRequestId,
      errorCode: err instanceof MaisterError ? err.code : "ACP_PROTOCOL",
    });
    rethrowSeqConflict(err);
  }

  log.debug(
    {
      runId: args.runId,
      hitlRequestId: args.hitlRequestId,
      live: !resumed,
      reverted: sensed.reverted,
      replyLen: replyBody.length,
    },
    "[gate-chat] turn complete",
  );

  return {
    userMessage: admitted.userMessage,
    agentMessage,
    resumed,
  };
}
