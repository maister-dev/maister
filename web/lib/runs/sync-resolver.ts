import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { nextKeepaliveAt } from "@/lib/runs/keepalive-config";
import {
  createExecutionHosts,
  isFencedError,
  type CreateSessionInput,
  type ExecutionHosts,
  type HostAdminClient,
  type PromptResult,
  type PromptStopReason,
  type SupervisorEvent,
} from "@/lib/execution-host";

// FIXME(any): dual drizzle-orm peer-dep variants — mirror sync-target.ts.
const { hitlRequests, runs, runSessions } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): the injected db seam is a Drizzle client OR a Testcontainers pg
// client; both expose select/insert/update/transaction.
type Db = any;

const log = pino({
  name: "sync-resolver",
  level: process.env.LOG_LEVEL ?? "info",
});

// The step id the resolver session (and its HITL rows) are stamped with.
export const SYNC_STEP_ID = "sync";

// ADR-166: the resolver's session create payload is handle-form — the run's
// worktree is the adopted workspace of its `sync_resolver` assignment; no path
// rides the wire.
export type ResolverSessionInput = Pick<
  CreateSessionInput,
  "stepId" | "sessionName" | "executor" | "runner"
>;

// The resolver's session teardown: a fenced `session.delete` under the run's
// newest assignment (released included — teardown kinds stay admissible).
// Best-effort: a host outage leaves the command queued for recovery.
export async function teardownResolverSession(
  hosts: ExecutionHosts,
  runId: string,
  sessionId: string,
): Promise<void> {
  try {
    const client = await hosts.forRun(runId, { teardown: true });

    await client.deleteSession(sessionId);
  } catch (err) {
    log.warn(
      {
        runId,
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      "sync resolver session teardown deferred",
    );
  }
}

// The fixed English resolver instruction (decision 5). Carries the target ref,
// strategy, the `git diff --name-only --diff-filter=U` conflicted-file list, and
// the task intent (NULL-SAFE for a taskless agent run). NEVER logged (may echo
// task content). Explicit prohibitions bound the resolver's blast radius; the
// no-push instruction is prompt-level (the enforced safety net is the web-side
// verification gate + explicit-SHA force-with-lease, per ADR-141).
export function buildResolverPrompt(args: {
  targetRef: string;
  strategy: "rebase" | "merge";
  conflictedFiles: readonly string[];
  task: { title: string | null; prompt: string | null } | null;
}): string {
  const files =
    args.conflictedFiles.length > 0
      ? args.conflictedFiles.map((file) => `- ${file}`).join("\n")
      : "- (none reported)";
  const intent =
    args.task && (args.task.title || args.task.prompt)
      ? [
          "",
          "The change under review (preserve its intent when resolving):",
          `Title: ${args.task.title ?? "(untitled)"}`,
          `Description: ${args.task.prompt ?? "(none)"}`,
        ].join("\n")
      : "";

  return [
    `A git ${args.strategy} of this run's branch onto "${args.targetRef}" hit conflicts and is paused in this worktree.`,
    "",
    "Conflicted files:",
    files,
    intent,
    "",
    "Your job:",
    `- Resolve every conflict, preserving BOTH sides' intent (the change under review AND the incoming changes from ${args.targetRef}).`,
    `- Complete the ${args.strategy} (stage the resolved files and continue it) so no ${args.strategy} is left in progress.`,
    "- Leave a clean working tree: no staged or unstaged changes and no leftover conflict markers.",
    "- Do NOT push. Do NOT touch files unrelated to the conflict.",
    "When the tree is clean and the operation is complete, stop.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function persistResolverPermission(args: {
  db: Db;
  runId: string;
  sessionId: string;
  event: Extract<SupervisorEvent, { type: "session.permission_request" }>;
}): Promise<void> {
  const toolCall = (args.event.toolCall ?? {}) as { title?: unknown };
  const prompt =
    typeof toolCall.title === "string"
      ? `Approve ${toolCall.title}?`
      : "Approve tool call?";

  await args.db.transaction(async (tx: Db) => {
    await tx.insert(hitlRequests).values({
      id: randomUUID(),
      runId: args.runId,
      stepId: SYNC_STEP_ID,
      kind: "permission",
      schema: {
        requestId: args.event.requestId,
        options: args.event.options,
        toolCall: args.event.toolCall,
        supervisorSessionId: args.sessionId,
      },
      prompt,
    });
    // Running → NeedsInput only. The respond route owns NeedsInput → Running.
    await tx
      .update(runs)
      .set({ status: "NeedsInput", keepaliveUntil: nextKeepaliveAt() })
      .where(and(eq(runs.id, args.runId), eq(runs.status, "Running")));
  });
}

type ResolverConsumer = {
  abort: AbortController;
  done: Promise<void>;
  permissionPersistFailure: () => { reason: string } | null;
};

// The resolver SSE consumer (scratch-shaped, minimal): a `permission_request`
// persists a `hitl_requests` row and parks the run in `NeedsInput`; a persistence
// failure is surfaced (never swallowed) so the driver tears the session down. It
// projects NO transcript. Breaks on session exit/crash or abort.
function startResolverConsumer(args: {
  db: Db;
  runId: string;
  sessionId: string;
  admin: HostAdminClient;
}): ResolverConsumer {
  const abort = new AbortController();
  let permissionPersistFailure: { reason: string } | null = null;

  const done = (async () => {
    try {
      for await (const event of args.admin.streamSession(args.sessionId, {
        signal: abort.signal,
      })) {
        if (event.type === "session.permission_request") {
          try {
            await persistResolverPermission({
              db: args.db,
              runId: args.runId,
              sessionId: args.sessionId,
              event,
            });
          } catch (err) {
            if (!permissionPersistFailure) {
              permissionPersistFailure = {
                reason: err instanceof Error ? err.message : String(err),
              };
            }
          }
          continue;
        }

        if (
          event.type === "session.exited" ||
          event.type === "session.crashed"
        ) {
          break;
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      log.warn(
        {
          runId: args.runId,
          sessionId: args.sessionId,
          err: (err as Error).message,
        },
        "sync resolver event consumer error",
      );
    }
  })();

  return {
    abort,
    done,
    permissionPersistFailure: () => permissionPersistFailure,
  };
}

// Spawn a FRESH resolver ACP session in the run worktree, drive one blocking
// prompt turn, and return the terminal stop reason. Deferred-release is MANDATORY
// (ADR-141): every path AFTER a successful `createSession` — a sendPrompt throw or
// a surfaced HITL persistence failure — tears the session down before rethrowing.
// The happy path leaves the session LIVE for the caller to verify+push then
// delete. NEVER logs prompt/output content.
export async function runResolverSession(args: {
  db: Db;
  runId: string;
  input: ResolverSessionInput;
  prompt: string;
  runnerTier: string;
  executionHosts?: ExecutionHosts;
  // ADR-166: the `sync_resolver` generation the claim minted.
  assignmentId?: string | null;
}): Promise<{ sessionId: string; stopReason: PromptStopReason }> {
  const hosts = args.executionHosts ?? createExecutionHosts({ db: args.db });
  // Bound to the `sync_resolver` generation the claim minted.
  const { client, admin } = await hosts.executionFor(args.runId, {
    assignmentId: args.assignmentId,
  });
  const created = await client.createSession(args.input);
  const sessionId = created.sessionId;

  // Persist the ACP handle onto the resolver's `run_sessions` row. The row is
  // inserted in the CAS tx BEFORE the session exists, so it starts null — and
  // nothing ever wrote it, which made reconcile's whole W2 arm unreachable:
  // `activeRunSessionsFor` resolves `liveSession` from this column, so a live
  // resolver always looked session-less. Worse than merely null — that helper
  // lets a LATER row replace an incumbent only when the incumbent lacks a
  // handle, so the handle-less resolver row loses to the run's OLD flow session
  // and W2 would tear THAT session down instead.
  //
  // Fails closed under the module's deferred-release contract: an unpersisted
  // handle means a crash leaves an agent process nothing can find or kill, which
  // is strictly worse than not resolving at all.
  try {
    await args.db
      .update(runSessions)
      .set({ acpSessionId: created.acpSessionId, updatedAt: new Date() })
      .where(
        and(
          eq(runSessions.runId, args.runId),
          eq(runSessions.sessionName, args.input.sessionName),
        ),
      );
  } catch (err) {
    await client.deleteSession(sessionId).catch(() => undefined);
    throw new MaisterError(
      "CRASH",
      `sync resolver could not persist its acp session handle: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // ADR-141: mark this run as owned by a LIVE in-process resolver
  // driver — the skip-vs-abort discriminant for the periodic reconcile sweep.
  // Registration is owned by `syncRunTarget`, which spans this session AND the
  // mechanical rebase before it, and the verify/push after it. It is deliberately
  // NOT re-registered here: the registry is a plain Set, so a `finally` here would
  // drop the driver while `syncRunTarget` is still pushing — re-opening the very
  // orphan window the registry exists to close.
  log.info(
    {
      runId: args.runId,
      sessionId,
      sessionName: args.input.sessionName,
      runnerTier: args.runnerTier,
    },
    "sync resolver session spawned",
  );

  const consumer = startResolverConsumer({
    db: args.db,
    runId: args.runId,
    sessionId,
    admin,
  });

  let promptResult: PromptResult;

  try {
    const promptHandle = await client.prompt(sessionId, {
      stepId: SYNC_STEP_ID,
      prompt: args.prompt,
    });

    promptResult = await client.waitForPrompt(promptHandle);
  } catch (err) {
    consumer.abort.abort();
    await consumer.done.catch(() => undefined);
    // A fenced turn belongs to a superseded generation: the host already
    // evicted the session, and tearing it down is not this driver's to do.
    if (!isFencedError(err)) {
      await client.deleteSession(sessionId).catch(() => undefined);
    }
    throw err;
  }

  consumer.abort.abort();
  await consumer.done;

  const persistFailure = consumer.permissionPersistFailure();

  if (persistFailure) {
    await client.deleteSession(sessionId).catch(() => undefined);
    throw new MaisterError(
      "CRASH",
      `sync resolver HITL persistence failed: ${persistFailure.reason}`,
    );
  }

  log.info(
    { runId: args.runId, sessionId, stopReason: promptResult.stopReason },
    "sync resolver session ended",
  );

  return { sessionId, stopReason: promptResult.stopReason };
}
