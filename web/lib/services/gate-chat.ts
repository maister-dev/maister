import "server-only";

import type { ExecutionAssignment } from "@/lib/db/schema";

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { and, asc, eq, lt, sql } from "drizzle-orm";
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
  type PromptResult,
  type SupervisorEvent,
  type SupervisorSessionRecord,
} from "@/lib/execution-host";
import {
  createExecutionHosts,
  isFencedError,
  type BoundClient,
  type ExecutionHosts,
  type HostAdminClient,
} from "@/lib/execution-host";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { gateChatMessages, gateChatTurns, hitlRequests, runs, workspaces } =
  schemaModule as unknown as Record<string, any>;

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

// Recovery runs outside the request that owned the prompt. Its lease prevents a
// second web process from restoring the same workspace while the first recovery
// is still bounded by supervisor cancellation and the L3 git probe.
const GATE_CHAT_RECOVERY_LEASE_MS = 15 * 60_000;
const GATE_CHAT_RECOVERY_BATCH_SIZE = 50;

type GateChatTurnState = "pending" | "completed" | "failed" | "aborted";

type GateChatTurnRow = {
  id: string;
  state: GateChatTurnState;
  leaseExpiresAt: Date | null;
};

type GateChatTurnDeadline = {
  clear: () => void;
  expired: () => boolean;
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

function recoveryLeaseExpiresAt(now: Date): Date {
  return new Date(now.getTime() + GATE_CHAT_RECOVERY_LEASE_MS);
}

function armGateChatTurnDeadline(args: {
  client: BoundClient;
  hitlRequestId: string;
  runId: string;
  sessionId: string;
  leaseExpiresAt: Date;
}): GateChatTurnDeadline {
  const delayMs = Math.max(0, args.leaseExpiresAt.getTime() - Date.now());
  let leaseExpired = false;
  const timer = setTimeout(() => {
    leaseExpired = true;
    void args.client
      .cancelPrompt(args.sessionId)
      .then(({ cancelled }) => {
        log.warn(
          {
            runId: args.runId,
            hitlRequestId: args.hitlRequestId,
            sessionId: args.sessionId,
            cancelled,
          },
          "[FIX:gate-chat-lease] cancellation requested after lease expiry",
        );
      })
      .catch((err: unknown) => {
        log.error(
          {
            runId: args.runId,
            hitlRequestId: args.hitlRequestId,
            sessionId: args.sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          "[FIX:gate-chat-lease] cancellation request failed",
        );
      });
  }, delayMs);

  timer.unref?.();

  return {
    clear: () => clearTimeout(timer),
    expired: () => leaseExpired,
  };
}

// This helper is intentionally called while the HITL row is already locked.
// Both response claim and chat admission take locks hitl_request → turn, which
// keeps a response fenced from the ACP prompt without retaining a transaction
// across the prompt or its mandatory L3 restore. Expired rows stay fenced until
// reconcile owns their cancellation and restore; lease expiry is never a claim
// permission by itself.
export async function requireNoLiveGateChatTurn(
  tx: Db,
  hitlRequestId: string,
): Promise<void> {
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
}

// Preview is deliberately read-only: it neither expires nor mutates a chat
// coordinator. It rejects every active coordinator because a preview that
// cannot be confirmed would be misleading to the reviewer.
export async function assertNoActiveGateChatTurn(
  db: Db,
  hitlRequestId: string,
): Promise<void> {
  const rows = (await db
    .select({ id: gateChatTurns.id })
    .from(gateChatTurns)
    .where(
      and(
        eq(gateChatTurns.hitlRequestId, hitlRequestId),
        eq(gateChatTurns.state, "pending"),
      ),
    )
    .limit(1)) as Array<{ id: string }>;

  if (rows[0]) {
    throw new MaisterError(
      "PRECONDITION",
      "a gate-chat turn is still in progress; retry after it completes",
    );
  }
}

async function failGateChatTurn(args: {
  db: Db;
  turnId: string;
  hitlRequestId: string;
  errorCode: string;
  terminalState?: "failed" | "aborted";
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
        state: args.terminalState ?? (isClaimed ? "aborted" : "failed"),
        leaseExpiresAt: null,
        completedAt: new Date(),
        errorCode: args.errorCode,
      })
      .where(eq(gateChatTurns.id, args.turnId));
  });
}

// ADR-166: the chat turn rides the client bound to the run's assignment — the
// live driver's epoch on a NeedsInput run, a fresh `gate_chat` generation on
// an idle one (D2). Host-scoped reads (session list, stream) go through the
// admin client.

type ExpiredGateChatCandidate = {
  id: string;
  runId: string;
  hitlRequestId: string;
};

type ClaimedGateChatRecovery = ExpiredGateChatCandidate & {
  worktreePath: string;
  baselineRef: string;
  recoveryLeaseExpiresAt: Date;
};

async function claimExpiredGateChatRecovery(args: {
  db: Db;
  candidate: ExpiredGateChatCandidate;
  now: Date;
}): Promise<ClaimedGateChatRecovery | null> {
  return await args.db.transaction(async (tx: Db) => {
    // Keep the lock order identical to response claim and chat admission.
    const hitlRows = await tx
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(eq(hitlRequests.id, args.candidate.hitlRequestId))
      .for("update");

    if (!hitlRows[0]) return null;

    const turnRows = await tx
      .select({
        id: gateChatTurns.id,
        state: gateChatTurns.state,
        leaseExpiresAt: gateChatTurns.leaseExpiresAt,
      })
      .from(gateChatTurns)
      .where(eq(gateChatTurns.id, args.candidate.id))
      .for("update");
    const turn = turnRows[0] as GateChatTurnRow | undefined;

    if (
      !turn ||
      turn.state !== "pending" ||
      turn.leaseExpiresAt === null ||
      turn.leaseExpiresAt.getTime() >= args.now.getTime()
    ) {
      return null;
    }

    const workspaceRows = await tx
      .select({
        worktreePath: workspaces.worktreePath,
        removedAt: workspaces.removedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.runId, args.candidate.runId))
      .limit(1);
    const workspace = workspaceRows[0];

    if (!workspace || workspace.removedAt !== null) {
      throw new MaisterError(
        "CHECKPOINT",
        `gate-chat recovery cannot restore workspace for run ${args.candidate.runId}`,
      );
    }

    const recoveryLease = recoveryLeaseExpiresAt(args.now);

    await tx
      .update(gateChatTurns)
      .set({ leaseExpiresAt: recoveryLease })
      .where(
        and(
          eq(gateChatTurns.id, turn.id),
          eq(gateChatTurns.state, "pending"),
          eq(gateChatTurns.leaseExpiresAt, turn.leaseExpiresAt),
        ),
      );

    return {
      ...args.candidate,
      worktreePath: workspace.worktreePath,
      baselineRef: checkpointRefName(
        "chat-checkpoints",
        args.candidate.runId,
        args.candidate.hitlRequestId,
      ),
      recoveryLeaseExpiresAt: recoveryLease,
    };
  });
}

async function completeExpiredGateChatRecovery(args: {
  db: Db;
  recovery: ClaimedGateChatRecovery;
}): Promise<boolean> {
  return await args.db.transaction(async (tx: Db) => {
    // The response path locks this row first. Retain that order before taking
    // the turn lock so recovery never deadlocks with a concurrent claim.
    const hitlRows = await tx
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(eq(hitlRequests.id, args.recovery.hitlRequestId))
      .for("update");

    if (!hitlRows[0]) return false;

    const turnRows = await tx
      .select({
        id: gateChatTurns.id,
        state: gateChatTurns.state,
        leaseExpiresAt: gateChatTurns.leaseExpiresAt,
      })
      .from(gateChatTurns)
      .where(eq(gateChatTurns.id, args.recovery.id))
      .for("update");
    const turn = turnRows[0] as GateChatTurnRow | undefined;

    if (
      !turn ||
      turn.state !== "pending" ||
      turn.leaseExpiresAt?.getTime() !==
        args.recovery.recoveryLeaseExpiresAt.getTime()
    ) {
      return false;
    }

    await tx
      .update(gateChatTurns)
      .set({
        state: "aborted",
        leaseExpiresAt: null,
        completedAt: new Date(),
        errorCode: "LEASE_EXPIRED",
      })
      .where(eq(gateChatTurns.id, turn.id));

    return true;
  });
}

// Process death clears the in-memory deadline, not the database coordinator.
// Reconcile owns this durable recovery: claim the expired turn by extending its
// fence, cancel any still-live supervisor prompt, run L3 restore, and only then
// release response admission by terminalizing it. A failed cancellation or
// restore intentionally leaves the turn pending for the next recovery lease.
export async function recoverExpiredGateChatTurns(args: {
  db?: Db;
  sessions: SupervisorSessionRecord[];
  executionHosts?: ExecutionHosts;
  now?: () => Date;
}): Promise<number> {
  const d = args.db ?? getDb();
  const hosts = args.executionHosts ?? createExecutionHosts({ db: d });
  const now = args.now ?? (() => new Date());
  const observedAt = now();
  const candidates = (await d
    .select({
      id: gateChatTurns.id,
      runId: gateChatTurns.runId,
      hitlRequestId: gateChatTurns.hitlRequestId,
    })
    .from(gateChatTurns)
    .where(
      and(
        eq(gateChatTurns.state, "pending"),
        lt(gateChatTurns.leaseExpiresAt, observedAt),
      ),
    )
    .orderBy(asc(gateChatTurns.leaseExpiresAt))
    .limit(GATE_CHAT_RECOVERY_BATCH_SIZE)) as ExpiredGateChatCandidate[];
  let recovered = 0;

  for (const candidate of candidates) {
    let claim: ClaimedGateChatRecovery | null;

    try {
      claim = await claimExpiredGateChatRecovery({
        db: d,
        candidate,
        // Claim time, not scan time: a bounded batch is processed serially,
        // so a later turn must receive a full recovery lease of its own.
        now: now(),
      });
    } catch (err) {
      log.error(
        {
          runId: candidate.runId,
          hitlRequestId: candidate.hitlRequestId,
          turnId: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "[FIX:gate-chat-recovery] could not claim expired turn; response remains fenced",
      );
      continue;
    }

    if (!claim) continue;

    const liveSession = args.sessions.find(
      (session) => session.runId === claim.runId && session.status === "live",
    );

    try {
      const cancellation = liveSession
        ? await (
            await hosts.forRun(claim.runId, { teardown: true })
          ).cancelPrompt(liveSession.sessionId)
        : null;
      const sensed = await senseAndRestore({
        worktreePath: claim.worktreePath,
        baselineRef: claim.baselineRef,
      });
      const terminalized = await completeExpiredGateChatRecovery({
        db: d,
        recovery: claim,
      });

      if (!terminalized) {
        log.warn(
          {
            runId: claim.runId,
            hitlRequestId: claim.hitlRequestId,
            turnId: claim.id,
          },
          "[FIX:gate-chat-recovery] expired turn changed while restoring; fence remains owned elsewhere",
        );
        continue;
      }

      recovered += 1;
      log.warn(
        {
          runId: claim.runId,
          hitlRequestId: claim.hitlRequestId,
          turnId: claim.id,
          sessionId: liveSession?.sessionId ?? null,
          cancelled: cancellation?.cancelled ?? false,
          reverted: sensed.reverted,
        },
        "[FIX:gate-chat-recovery] expired turn cancelled, restored, and terminalized",
      );
    } catch (err) {
      log.error(
        {
          runId: claim.runId,
          hitlRequestId: claim.hitlRequestId,
          turnId: claim.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "[FIX:gate-chat-recovery] cancellation or restore failed; response remains fenced",
      );
    }
  }

  return recovered;
}

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
  executionHosts?: ExecutionHosts;
}): Promise<SendGateChatTurnResult> {
  const d = args.db ?? getDb();
  const hosts = args.executionHosts ?? createExecutionHosts({ db: d });

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
    leaseExpiresAt: Date;
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

      const leaseExpiresAt = turnLeaseExpiresAt(new Date());
      const turnRows = await tx
        .insert(gateChatTurns)
        .values({
          runId: args.runId,
          hitlRequestId: args.hitlRequestId,
          userMessageId: userMessage.id,
          state: "pending",
          leaseExpiresAt,
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
        leaseExpiresAt,
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
  // Assigned on every non-throwing branch below (live lookup or chat resume).
  let client!: BoundClient;
  let admin!: HostAdminClient;

  try {
    if (run.status === "NeedsInput") {
      // The live driver's epoch: the chat turn reuses the run's ACTIVE
      // assignment (Q5) and its live session.
      client = await hosts.forRun(args.runId);
      const sessions = await client.sessionsForRun();
      const live = sessions.find((s) => s.status === "live");

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
    // ADR-166 E-EH-11: a fenced spawn means a newer generation owns the run —
    // the turn is that driver's to settle; write nothing.
    if (isFencedError(err)) {
      log.warn(
        { runId: args.runId, hitlRequestId: args.hitlRequestId },
        "driver-yielded",
      );
      throw err;
    }
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
    let claimed: ExecutionAssignment | undefined;

    if (idleClaim) {
      // The idle resume is a new driver generation minted as `gate_chat`.
      const claim = await markResumed(args.runId, {
        db: d,
        placement: { reason: "gate_chat", transport: hosts.transport },
      });

      if (!claim.ok) {
        throw new MaisterError(
          "CONFLICT",
          "concurrent resume in progress for this run — retry once it settles",
        );
      }
      claimed = claim.assignment;
    }

    let created: { sessionId: string };

    try {
      // Bound to the generation the idle claim minted; a crash-window respawn
      // on a still-live pause reuses the run's active assignment (Q5).
      client = claimed
        ? await hosts.forAssignment(claimed)
        : await hosts.forRun(args.runId);
      created = await client.createSession({
        stepId,
        executor: {
          agent: (run.runnerSnapshot?.capabilityAgent ?? "claude") as
            | "claude"
            | "codex",
          model: run.runnerSnapshot?.model ?? "unknown",
        },
        runner: run.runnerSnapshot
          ? runnerSupervisorInput({ snapshot: run.runnerSnapshot })
          : undefined,
        resumeSessionId: activeAcpSessionId as string,
      });
    } catch (err) {
      // A fenced create means a newer generation owns the run — its claim is
      // not ours to roll back (E-EH-11).
      if (idleClaim && !isFencedError(err)) {
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

  // A run-bound reader reconstructs canonical sessions from Postgres. The
  // host-global admin client remains reserved for host operational reads.
  admin = (
    await hosts.executionFor(args.runId, {
      assignmentId: client.assignment.id,
    })
  ).admin;

  // (4b) prompt — L1 preamble + verbatim reviewer text (NEVER templated),
  // L2 readOnlyTurn flag, DD4 stepId marker. Reply text accumulates from the
  // session stream (chat_turn event preferred, chunks as fallback).
  let replyFromEvent: string | null = null;
  let replyChunks = "";
  const abort = new AbortController();
  const consumer = (async () => {
    try {
      for await (const ev of admin.streamSession(supervisorSessionId, {
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

  const deadline = armGateChatTurnDeadline({
    client,
    hitlRequestId: args.hitlRequestId,
    runId: args.runId,
    sessionId: supervisorSessionId,
    leaseExpiresAt: admitted.leaseExpiresAt,
  });
  let promptResult: PromptResult;

  try {
    const handle = await client.prompt(supervisorSessionId, {
      stepId,
      prompt: GATE_CHAT_READONLY_PREAMBLE + args.message,
      readOnlyTurn: true,
    });

    promptResult = await client.waitForPrompt(handle);
  } catch (err) {
    // X-DEFER: release the stream consumer on EVERY failure path.
    abort.abort();
    await consumer;
    // ADR-166 E-EH-11: a fenced prompt means a newer generation owns the run
    // — the turn is that driver's to settle; write nothing.
    if (isFencedError(err)) {
      log.warn(
        { runId: args.runId, hitlRequestId: args.hitlRequestId },
        "driver-yielded",
      );
      throw err;
    }
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
  } finally {
    deadline.clear();
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

  if (promptResult.stopReason === "cancelled") {
    await failGateChatTurn({
      db: d,
      turnId: admitted.turnId,
      hitlRequestId: args.hitlRequestId,
      errorCode: deadline.expired() ? "LEASE_EXPIRED" : "PROMPT_CANCELLED",
      terminalState: "aborted",
    });
    throw new MaisterError(
      "PRECONDITION",
      "gate-chat turn was cancelled; retry after the workspace restore completes",
    );
  }

  // (6) persist the agent turn and mark the coordinator completed in one
  // transaction. A pending coordinator fences response claim until this L3
  // restore has completed; lease expiry requests cancellation but never clears
  // that fence early.
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
