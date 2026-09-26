import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RunnerSnapshot } from "@/lib/acp-runners/resolve";
import type { CreateSessionPayload } from "@/lib/execution-host/contracts";
import type { LibrarianPromptVariant } from "./prompt-owner";
import type { ComposerMessage } from "./composer";
import type { LibrarianSubject } from "./types";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import {
  issueLibrarianTurnToken,
  revokeLibrarianTurnToken,
  scopesForLibrarianTurn,
} from "./authority";
import {
  composeLibrarianContext,
  composeResumePrompt,
  decideSessionMode,
} from "./composer";
import { librarianConfig } from "./config";
import { lockOwnerConversation } from "./conversation";
import {
  LIBRARIAN_INSTRUCTIONS_VERSION,
  librarianInstructions,
} from "./instructions";
import { admitLibrarianPrompt, librarianPromptOwners } from "./prompt-owner";
import {
  librarianEnforcementProfile,
  librarianFacadeServer,
  librarianSummaryEnforcementProfile,
  materializeLibrarianAdapterSettings,
  materializeLibrarianSummaryAdapterSettings,
} from "./session-profile";
import {
  librarianRunnerIneligibility,
  readLibrarianSettings,
} from "./settings";
import { computeAuthzFingerprint, writeContextSnapshot } from "./snapshot";
import {
  afterLibrarianTurnFinished,
  finishLibrarianTurnInTransaction,
  type LibrarianTurnEnd,
} from "./turn-end";
import { ensureLibrarianWorkspace } from "./workspace";
import { retrieveLibrarianContext } from "./retrieval";
import { LIBRARIAN_SUMMARY_INSTRUCTIONS } from "./summary";

import {
  mergeRunnerAdapterLaunch,
  runnerExecutorInput,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import { snapshotRunner } from "@/lib/acp-runners/resolve";
import { getDb } from "@/lib/db/client";
import {
  librarianContextSnapshots,
  librarianConversations,
  librarianMessages,
  librarianTurns,
  runSessions,
  runs,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host";
import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "librarian.runtime",
  level: process.env.LOG_LEVEL ?? "info",
});

export const LIBRARIAN_STEP_ID = "librarian";
// D19: a turn whose start keeps failing is failed `start_failed` after this.
export const LIBRARIAN_MAX_START_ATTEMPTS = 3;

export type LibrarianRuntimeDeps = {
  db?: Db;
  hosts?: ExecutionHosts;
  now?: () => Date;
};

type PreparedStart = {
  turnId: string;
  runId: string;
  assignmentId: string;
  conversationId: string;
  variant: LibrarianPromptVariant;
  runner: RunnerSnapshot;
  mode: "resume" | "new";
  resumeSessionId: string | null;
  freshPrompt: string;
  resumePrompt: string;
  epoch: number;
  tokenSecret: string | null;
  deadlineAt: Date;
};

type StartRefusal = { refused: true; reason: string };

async function latestFingerprint(
  tx: Db,
  conversationId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ fingerprint: librarianContextSnapshots.authzFingerprint })
    .from(librarianContextSnapshots)
    .innerJoin(
      librarianTurns,
      eq(librarianTurns.id, librarianContextSnapshots.turnId),
    )
    .where(eq(librarianTurns.conversationId, conversationId))
    .orderBy(desc(librarianContextSnapshots.createdAt))
    .limit(1);

  return row?.fingerprint ?? null;
}

/** ONE transaction: re-checks the claim, bumps the context epoch on an authz
 * change, composes and snapshots the context, flips the turn `running` and
 * mints its token. Nothing reaches the host before this commits. */
async function prepareStart(
  db: Db,
  turnId: string,
  now: Date,
): Promise<PreparedStart | StartRefusal> {
  return db.transaction(async (tx) => {
    const [ref] = await tx
      .select({ userId: librarianConversations.userId })
      .from(librarianTurns)
      .innerJoin(
        librarianConversations,
        eq(librarianConversations.id, librarianTurns.conversationId),
      )
      .where(eq(librarianTurns.id, turnId));

    if (!ref) return { refused: true, reason: "turn_missing" };
    const locked = await lockOwnerConversation(tx, ref.userId);
    const [turn] = await tx
      .select()
      .from(librarianTurns)
      .where(eq(librarianTurns.id, turnId))
      .for("update");

    if (
      !turn ||
      !(turn.status === "admitted" || turn.status === "running") ||
      turn.startAttempts >= LIBRARIAN_MAX_START_ATTEMPTS
    )
      return { refused: true, reason: `turn_${turn?.status ?? "missing"}` };
    const runId = locked.conversation.runId;
    const [run] = runId
      ? await tx
          .select({
            status: runs.status,
            assignmentId: runs.executionAssignmentId,
          })
          .from(runs)
          .where(eq(runs.id, runId))
      : [];

    if (!runId || run?.status !== "Running" || !run.assignmentId)
      return { refused: true, reason: "run_not_claimed" };
    const settings = await readLibrarianSettings(tx);
    const runnerEntry = settings.runner;

    if (
      !runnerEntry ||
      !runnerEntry.enabled ||
      !runnerEntry.ready ||
      librarianRunnerIneligibility(runnerEntry)
    )
      return { refused: true, reason: "runner_unavailable" };
    const runner = snapshotRunner(runnerEntry);
    const fingerprint = await computeAuthzFingerprint(tx, ref.userId);
    const previous = await latestFingerprint(tx, locked.conversation.id);
    let epoch = locked.conversation.contextEpoch;

    if (previous !== null && previous !== fingerprint) {
      epoch += 1;
      await tx
        .update(librarianConversations)
        .set({ contextEpoch: epoch, updatedAt: now })
        .where(eq(librarianConversations.id, locked.conversation.id));
      log.info(
        { conversationId: locked.conversation.id, epoch },
        "librarian context epoch bumped: authz changed",
      );
    }
    const [message] = turn.messageId
      ? await tx
          .select()
          .from(librarianMessages)
          .where(eq(librarianMessages.id, turn.messageId))
      : [];

    if (!message) return { refused: true, reason: "message_missing" };
    const current: ComposerMessage = {
      id: message.id,
      seq: BigInt(message.seq),
      authorKind: turn.variant === "summary" ? "librarian" : "owner",
      body: message.body,
    };
    const retrieved = await retrieveLibrarianContext(tx, {
      ownerId: ref.userId,
      segmentId: turn.segmentId,
      beforeSeq: BigInt(message.seq),
      forgetGeneration: locked.conversation.forgetGeneration,
      historyGeneration: locked.conversation.historyGeneration,
      useMemory: locked.conversation.memoryEnabledNextSegment,
    });
    const subject =
      turn.variant === "summary"
        ? null
        : ((message.subject ?? null) as LibrarianSubject | null);
    const composed = composeLibrarianContext({
      instructions:
        turn.variant === "summary"
          ? LIBRARIAN_SUMMARY_INSTRUCTIONS
          : librarianInstructions(),
      instructionsVersion:
        turn.variant === "summary"
          ? "summary-v1"
          : LIBRARIAN_INSTRUCTIONS_VERSION,
      subject,
      history: retrieved.history,
      current,
      summaries: turn.variant === "summary" ? [] : retrieved.summaries,
      memoryItems: turn.variant === "summary" ? [] : retrieved.memoryItems,
      maxChars: librarianConfig().contextMaxChars,
    });
    const [session] = await tx
      .select({
        acpSessionId: runSessions.acpSessionId,
        epoch: runSessions.librarianContextEpoch,
        runnerId: runSessions.runnerId,
      })
      .from(runSessions)
      .where(
        and(
          eq(runSessions.runId, runId),
          eq(runSessions.sessionName, "default"),
        ),
      );
    const mode =
      turn.variant === "summary"
        ? "new"
        : decideSessionMode({
            acpSessionId: session?.acpSessionId ?? null,
            sessionEpoch: session?.epoch ?? null,
            sessionRunnerId: session?.runnerId ?? null,
            conversationEpoch: epoch,
            runnerId: runner.id,
          });

    await writeContextSnapshot(tx, {
      turnId,
      composed,
      authzFingerprint: fingerprint,
      contextEpoch: epoch,
    });
    const deadlineAt = new Date(
      now.getTime() + librarianConfig().turnMaxMinutes * 60_000,
    );

    // A restarted start mints a fresh token: the previous secret died with the
    // process that held it.
    await revokeLibrarianTurnToken(turnId, tx);
    const token =
      turn.variant === "summary"
        ? null
        : await issueLibrarianTurnToken(
            {
              ownerUserId: ref.userId,
              turnId,
              scopes: [...scopesForLibrarianTurn(turn.variant)],
              expiresAt: deadlineAt,
            },
            tx,
          );

    await tx
      .update(librarianTurns)
      .set({
        status: "running",
        startedAt: turn.startedAt ?? now,
        deadlineAt,
        runnerSnapshot: runner as never,
        tokenId: token?.tokenId ?? null,
        startAttempts: turn.startAttempts + 1,
      })
      .where(eq(librarianTurns.id, turnId));
    log.info(
      {
        turnId,
        runId,
        from: turn.status,
        to: "running",
        mode,
        epoch,
        messages: composed.messageIds.length,
        chars: composed.charCount,
        truncated: composed.truncated,
        epochMatch: mode === "resume",
      },
      "librarian turn started",
    );

    return {
      turnId,
      runId,
      assignmentId: run.assignmentId,
      conversationId: locked.conversation.id,
      variant: turn.variant as LibrarianPromptVariant,
      runner,
      mode,
      resumeSessionId:
        mode === "resume" ? (session?.acpSessionId ?? null) : null,
      freshPrompt: composed.prompt,
      resumePrompt: composeResumePrompt({ subject, current }),
      epoch,
      tokenSecret: token?.secret ?? null,
      deadlineAt,
    };
  });
}

/** Ends the turn through the shared transaction and runs its after-commit. */
export async function endLibrarianTurn(
  db: Db,
  turnId: string,
  end: LibrarianTurnEnd,
  fromStatuses: readonly ("admitted" | "running")[] = ["running"],
): Promise<boolean> {
  const finish = await db.transaction((tx) =>
    finishLibrarianTurnInTransaction(tx, { turnId, end, fromStatuses }),
  );

  await afterLibrarianTurnFinished(db, finish);

  return finish !== null;
}

function sessionPayload(
  prepared: PreparedStart,
  resumeSessionId: string | null,
): Omit<CreateSessionPayload, "executionWorkspaceId"> {
  return {
    stepId: LIBRARIAN_STEP_ID,
    sessionName: "default",
    executor: runnerExecutorInput(prepared.runner),
    runner: runnerSupervisorInput({ snapshot: prepared.runner }),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    adapterLaunch: mergeRunnerAdapterLaunch(prepared.runner),
    mcpServers:
      prepared.variant === "summary"
        ? []
        : [librarianFacadeServer(prepared.tokenSecret!)],
    // D5: L3 — an admitted MCP call never becomes a permission request that
    // would need a HITL row; L1 (the profile) decides first.
    autoApprovePermissions: true,
    enforcementProfile:
      prepared.variant === "summary"
        ? librarianSummaryEnforcementProfile()
        : librarianEnforcementProfile(),
  };
}

function isResumeRefusal(err: unknown): boolean {
  return (
    isMaisterError(err) &&
    (err.code === "CHECKPOINT" || err.code === "ACP_PROTOCOL")
  );
}

/** ADR-183: runs one admitted turn end to end — context, token, session,
 * prompt — and returns once the turn's owner has applied its outcome. Every
 * failure after `running` ends the turn; a prompt already issued is cancelled
 * first so no agent keeps acting on a turn the conversation gave up on. */
export async function startLibrarianTurn(
  turnId: string,
  deps: LibrarianRuntimeDeps = {},
): Promise<void> {
  const db = deps.db ?? (getDb() as unknown as Db);
  const now = (deps.now ?? (() => new Date()))();
  const prepared = await prepareStart(db, turnId, now);

  if ("refused" in prepared) {
    log.warn({ turnId, reason: prepared.reason }, "librarian turn not started");
    if (prepared.reason === "runner_unavailable")
      await endLibrarianTurn(
        db,
        turnId,
        {
          status: "failed",
          reason: "start_failed",
        },
        ["admitted", "running"],
      );

    return;
  }
  const hosts = deps.hosts ?? createExecutionHosts({ db });
  let promptIssued: { sessionId: string } | null = null;
  let client: Awaited<ReturnType<ExecutionHosts["forAssignment"]>> | null =
    null;
  const deadline = setTimeout(
    () => {
      void (async () => {
        if (promptIssued && client)
          await client.cancelPrompt(promptIssued.sessionId).catch(() => {});
        await endLibrarianTurn(db, turnId, {
          status: "failed",
          reason: "deadline",
        });
      })().catch((err: unknown) =>
        log.error(
          { turnId, err: err instanceof Error ? err.message : String(err) },
          "librarian deadline handling failed",
        ),
      );
    },
    Math.max(0, prepared.deadlineAt.getTime() - Date.now()),
  );

  deadline.unref?.();
  try {
    client = (
      await hosts.executionFor(prepared.runId, {
        assignmentId: prepared.assignmentId,
      })
    ).client;
    const bound = client;
    const cwd = await ensureLibrarianWorkspace(prepared.conversationId);

    if (prepared.variant === "summary")
      await materializeLibrarianSummaryAdapterSettings(
        cwd,
        prepared.runner.capabilityAgent,
      );
    else
      await materializeLibrarianAdapterSettings(
        cwd,
        prepared.runner.capabilityAgent,
      );
    let session: Awaited<ReturnType<typeof bound.createOwnedSession>> | null =
      null;
    let prompt = prepared.freshPrompt;
    let freshOrdinal = 0;

    if (prepared.mode === "resume" && prepared.resumeSessionId) {
      try {
        session = await bound.createOwnedSession(
          { variant: "librarian", turnId, promptOrdinal: 0 },
          async () => sessionPayload(prepared, prepared.resumeSessionId),
        );
        prompt = prepared.resumePrompt;
      } catch (err) {
        if (!isResumeRefusal(err)) throw err;
        log.warn(
          { turnId, code: isMaisterError(err) ? err.code : "UNKNOWN" },
          "librarian session/resume refused; starting a new session",
        );
        freshOrdinal = 1;
      }
    }
    if (!session) {
      session = await bound.createOwnedSession(
        { variant: "librarian", turnId, promptOrdinal: freshOrdinal },
        async () => sessionPayload(prepared, null),
      );
      prompt = prepared.freshPrompt;
      await db
        .update(runSessions)
        .set({
          librarianContextEpoch: prepared.epoch,
          runnerId: prepared.runner.id,
          runnerSnapshot: prepared.runner as never,
          capabilityAgent: prepared.runner.capabilityAgent as never,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runSessions.runId, prepared.runId),
            eq(runSessions.sessionName, "default"),
          ),
        );
    }
    const hostSessionId = session.hostSessionId;

    // Set BEFORE the call: a prompt call that fails may still have reached
    // the host, and cancelling an idle session is harmless.
    promptIssued = { sessionId: hostSessionId };
    const handle = await bound.prompt(
      hostSessionId,
      { stepId: LIBRARIAN_STEP_ID, prompt },
      {
        admitOwner: (tx) =>
          admitLibrarianPrompt(tx, bound, hostSessionId, {
            turnId,
            variant: prepared.variant,
          }),
      },
    );

    await bound.waitForPromptOwnerApplication(handle, {
      owners: librarianPromptOwners,
    });
  } catch (err) {
    const superseded =
      isMaisterError(err) && err.details?.reason === "prompt_owner_superseded";

    if (superseded) return;
    log.error(
      {
        turnId,
        runId: prepared.runId,
        code: isMaisterError(err) ? err.code : "UNKNOWN",
        err: err instanceof Error ? err.message : String(err),
        promptIssued: promptIssued !== null,
      },
      "librarian turn failed",
    );
    // Deferred release: a prompt already on the host is cancelled BEFORE the
    // turn is given up, and the token dies whatever else fails below.
    if (promptIssued && client)
      await client
        .cancelPrompt(promptIssued.sessionId)
        .catch((cause: unknown) =>
          log.warn(
            {
              turnId,
              err: cause instanceof Error ? cause.message : String(cause),
            },
            "librarian prompt cancel failed",
          ),
        );
    await revokeLibrarianTurnToken(turnId, db).catch(() => 0);
    await endLibrarianTurn(db, turnId, {
      status: "failed",
      reason: promptIssued ? "host_lost" : "start_failed",
    }).catch((cause: unknown) =>
      log.error(
        {
          turnId,
          err: cause instanceof Error ? cause.message : String(cause),
        },
        "librarian turn could not be ended; the sweep will",
      ),
    );
  } finally {
    clearTimeout(deadline);
  }
}
