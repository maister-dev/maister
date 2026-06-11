import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { and, eq, sql } from "drizzle-orm";
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
import { bumpKeepalive, markResumed } from "@/lib/runs/state-transitions";
import {
  createSession as defaultCreateSession,
  listSessions as defaultListSessions,
  sendPrompt as defaultSendPrompt,
  streamSession as defaultStreamSession,
  type SupervisorEvent,
} from "@/lib/supervisor-client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { gateChatMessages, hitlRequests, projects, runs, workspaces } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "gate-chat",
  level: process.env.LOG_LEVEL ?? "info",
});

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

// M30 (ADR-075 L1): the instruct layer — server-side constant prepended to
// every chat prompt, never user text. L2/L3 back it up.
export const GATE_CHAT_READONLY_PREAMBLE =
  "You are answering a reviewer's question at a review pause. This is a " +
  "READ-ONLY Q&A turn: do NOT modify, create, move, or delete any file in " +
  "the workspace, do not run commands that write, and do not commit. " +
  "Reading files to ground your answer is fine.\n\n";

// M30 (ADR-075 DD4): server-derived stepId marker — dash, never a colon
// (supervisor SAFE_PATH_SEGMENT); also names the per-step log file.
export function gateChatStepId(hitlRequestId: string): string {
  return `gate-chat-${hitlRequestId}`;
}

// M30 (ADR-075 DD2): session-presence-driven, answer-only availability.
export function gateChatAvailability(input: {
  runStatus: string;
  hitlKind: string | null;
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
  if (!input.acpSessionId) {
    return {
      available: false,
      reason: "no agent session to ask — the run has no resumable session",
    };
  }

  return { available: true };
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

// M30 (ADR-075 L3): the hard neutrality guarantee. Compares the current
// worktree content (tree probe + branch tip) against the first-turn
// baseline; on a delta restores the baseline (ADR-076 rewind overlay) and
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

// M30 (ADR-075): one answer-only chat turn. Order of operations (X-2PC):
//   1. server-state load + DD2 availability guard
//   2. L3 baseline ensure (fail-closed BEFORE any persist)
//   3. persist the user row (intent)
//   4. live → prompt the live session; idle → chat-resume (respawn with
//      session/resume + markResumed Idle→NeedsInput + keepalive) then prompt
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
  const run = runRows[0];
  const hitl = hitlRows[0];
  const workspace = workspaceRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${args.runId}`);
  }
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
    hitlRespondedAt: hitl.respondedAt,
    acpSessionId: run.acpSessionId,
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

  // (3) persist the user turn. The visit number mirrors the review schema's
  // gateAttempt (ADR-072) when present; non-review (form) pauses default to 1.
  const gateAttempt =
    typeof (hitl.schema as { gateAttempt?: unknown } | null)?.gateAttempt ===
    "number"
      ? ((hitl.schema as { gateAttempt: number }).gateAttempt)
      : 1;
  const seqRows = await d
    .select({ max: sql<number>`coalesce(max(${gateChatMessages.seq}), 0)` })
    .from(gateChatMessages)
    .where(eq(gateChatMessages.hitlRequestId, args.hitlRequestId));
  const baseSeq = Number(seqRows[0]?.max ?? 0);
  const userLabel = args.actorLabel ?? "user";
  const userInsert = await d
    .insert(gateChatMessages)
    .values({
      runId: args.runId,
      hitlRequestId: args.hitlRequestId,
      nodeId: hitl.stepId,
      gateAttempt,
      role: "user",
      authorUserId: args.actorUserId ?? null,
      authorLabel: userLabel,
      body: args.message,
      acpSessionId: run.acpSessionId,
      seq: baseSeq + 1,
    })
    .returning({
      id: gateChatMessages.id,
      createdAt: gateChatMessages.createdAt,
    });

  // (4) resolve the session: live (NeedsInput) vs chat-resume (Idle).
  const stepId = gateChatStepId(args.hitlRequestId);
  let supervisorSessionId: string;
  let resumed = false;

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

  async function chatResume(): Promise<string> {
    // DD3: respawn + ACP session/resume on the stored handle. MUST NOT call
    // the resumed-session driver and MUST NOT touch the hitl row — the run
    // re-idles via the sweeper.
    const created = await api.createSession({
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
      resumeSessionId: run.acpSessionId as string,
    });

    resumed = true;
    if (run.status === "NeedsInputIdle") {
      await markResumed(args.runId, { db: d });
    }
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
    throw new MaisterError(
      "ACP_PROTOCOL",
      `gate-chat prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  abort.abort();
  await consumer;

  // The pause stays warm while the reviewer is asking questions.
  await bumpKeepalive(args.runId, { db: d });

  // (5) L3 sense + restore — unconditional, fail-closed.
  const sensed = await senseAndRestore({
    worktreePath: workspace.worktreePath,
    baselineRef,
  });

  // (6) persist the agent turn — the marker lands AFTER the side-effects.
  const replyBody = replyFromEvent ?? replyChunks;
  const agentInsert = await d
    .insert(gateChatMessages)
    .values({
      runId: args.runId,
      hitlRequestId: args.hitlRequestId,
      nodeId: hitl.stepId,
      gateAttempt,
      role: "agent",
      authorUserId: null,
      authorLabel: "agent",
      body: replyBody,
      acpSessionId: run.acpSessionId,
      seq: baseSeq + 2,
      mutationReverted: sensed.reverted,
    })
    .returning({
      id: gateChatMessages.id,
      createdAt: gateChatMessages.createdAt,
    });

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
    userMessage: {
      id: userInsert[0].id,
      role: "user",
      authorLabel: userLabel,
      body: args.message,
      seq: baseSeq + 1,
      mutationReverted: false,
      createdAt: userInsert[0].createdAt,
    },
    agentMessage: {
      id: agentInsert[0].id,
      role: "agent",
      authorLabel: "agent",
      body: replyBody,
      seq: baseSeq + 2,
      mutationReverted: sensed.reverted,
      createdAt: agentInsert[0].createdAt,
    },
    resumed,
  };
}
