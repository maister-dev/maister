import "server-only";

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq } from "drizzle-orm";
import pino from "pino";

import { atomicWriteJson } from "@/lib/atomic";
import { createHitlAssignmentForRun } from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { isMaisterError } from "@/lib/errors";
import { markNodeNeedsInput } from "@/lib/flows/graph/ledger";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { runtimeRoot as configuredRuntimeRoot } from "@/lib/instance-config";
import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";
import { onStuckFromSnapshot } from "@/lib/runs/execution-policy";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants (mirrors keepalive-sweeper.ts).
const { hitlRequests, nodeAttempts, projects, runs } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "hook-trip",
  level: process.env.LOG_LEVEL ?? "info",
});

// Only the two liveness breakers HALT and reach the escalate path; `path_guard`
// is deny-and-continue (ADR-108 §2.4) and never escalates.
export type HookTripHaltRule = "repetition" | "no_progress";

export type EscalateHookTripArgs = {
  db: Db;
  runId: string;
  // flow → the node id; agent → the constant "agent" (no node_attempts row).
  stepId: string;
  supervisorSessionId: string;
  rule: HookTripHaltRule;
  toolCall?: unknown;
  runKind: "flow" | "agent";
  // Injected so each consumer passes its own supervisor api (mirrors the budget
  // watchdog which calls checkpointSession directly). An EXECUTOR_UNAVAILABLE
  // checkpoint re-throws (live halt, undeliverable → CRASH) — no state mutation,
  // no split-brain.
  checkpointSession: (sessionId: string) => Promise<unknown>;
};

export type EscalateHookTripResult = { escalated: boolean };

function hookTripPrompt(rule: HookTripHaltRule, toolCall: unknown): string {
  const title = (toolCall as { title?: string } | null)?.title;
  const which =
    rule === "repetition"
      ? "repeated the same tool call too many times"
      : "made no progress for too many turns";

  return title
    ? `Guardrail "${rule}" tripped: the agent ${which} (last tool: ${title}). Resume the run or abort.`
    : `Guardrail "${rule}" tripped: the agent ${which}. Resume the run or abort.`;
}

function hookTripSchema(
  rule: HookTripHaltRule,
  toolCall: unknown,
): Record<string, unknown> {
  return {
    kind: "hook_trip",
    rule,
    decisions: ["resume", "abort"],
    ...(toolCall ? { toolCall } : {}),
  };
}

type RunRow = {
  projectId: string | null;
  taskId: string | null;
  status: string;
  executionPolicy: unknown;
  projectSlug: string | null;
};

async function loadRun(db: Db, runId: string): Promise<RunRow | null> {
  const rows = await db
    .select({
      projectId: runs.projectId,
      taskId: runs.taskId,
      status: runs.status,
      executionPolicy: runs.executionPolicy,
      projectSlug: projects.slug,
    })
    .from(runs)
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId));

  return rows[0] ?? null;
}

async function fetchActiveAttempt(
  db: Db,
  runId: string,
  nodeId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        eq(nodeAttempts.nodeId, nodeId),
        eq(nodeAttempts.status, "Running"),
      ),
    )
    .orderBy(asc(nodeAttempts.attempt));

  return rows.length > 0 ? rows[rows.length - 1] : null;
}

// A halting guardrail trip (`repetition` / `no_progress`): checkpoint the live
// session to stop spend (the supervisor halted it but left the process alive),
// then CAS `Running → NeedsInput`, open a `hook_trip` HITL, and emit
// `run.needs_input` + `run.escalated`, all in ONE tx (ADR-086 exactly-once);
// then a post-commit audit line. Mirrors the ADR-101 `actBudgetEscalate`
// pattern, but is NOT flow-only — a hook-trip resume routes through each
// `run_kind`'s OWN resume path (flow `runFlow` / agent `startAgentSession`), not
// budget's `raise → runFlow`. Branches on `run_kind` for the node-attempt write
// (agent runs carry no `node_attempts`). THROWS on an `EXECUTOR_UNAVAILABLE`
// checkpoint — the supervisor halts once and never re-emits, so a swallowed bail
// would let the run advance as if the guardrail never fired; the consumer must
// surface a recoverable CRASH instead. Returns `escalated: false` only when there
// is nothing to escalate: run gone, run no longer `Running`, or a lost CAS.
export async function escalateHookTrip(
  args: EscalateHookTripArgs,
): Promise<EscalateHookTripResult> {
  const { runId, stepId, supervisorSessionId, rule, toolCall, runKind } = args;
  const db = args.db ?? getDb();
  const run = await loadRun(db, runId);

  if (!run) {
    log.warn({ runId }, "escalateHookTrip: run not found");

    return { escalated: false };
  }
  if (run.status !== "Running") {
    log.debug(
      { runId, status: run.status },
      "escalateHookTrip: run not Running — skip",
    );

    return { escalated: false };
  }

  // 1. Checkpoint pre-tx to stop spend. EXECUTOR_UNAVAILABLE means the halt is
  // LIVE (the supervisor already cancelled the agent's calls and will NOT re-emit
  // session.hook_trip) but undeliverable — re-throw with no mutation so the
  // consumer surfaces a recoverable CRASH (recover → session/resume) instead of
  // letting the run advance as if the guardrail never fired. No mutation here →
  // no split-brain. Any OTHER checkpoint failure means the session is already
  // gone; proceed to the pause.
  try {
    await args.checkpointSession(supervisorSessionId);
  } catch (err) {
    if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
      log.warn(
        { runId, err: err.message },
        "[hook-trip] escalate checkpoint 5xx — live halt undeliverable, surfacing CRASH",
      );

      throw err;
    }
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "[hook-trip] escalate checkpoint terminal failure — session unrecoverable, proceeding to pause",
    );
  }

  const onStuck = onStuckFromSnapshot(run.executionPolicy ?? null);
  const assign = onStuck !== "notify_only";
  const schema = hookTripSchema(rule, toolCall);
  const prompt = hookTripPrompt(rule, toolCall);
  const hitlRequestId = randomUUID();

  // 2. needs-input.json pre-tx (unlink on tx failure) — mirrors actBudgetEscalate.
  const needsInputPath = run.projectSlug
    ? path.join(
        runDirPath(configuredRuntimeRoot(), run.projectSlug, runId),
        "needs-input.json",
      )
    : null;

  // flow runs carry node_attempts; agent runs do not (stepId is the constant
  // "agent"). markNodeNeedsInput so a flow resume re-runs the node.
  const attempt =
    runKind === "flow" ? await fetchActiveAttempt(db, runId, stepId) : null;

  if (needsInputPath) {
    await atomicWriteJson(needsInputPath, {
      nodeId: stepId,
      kind: "hook_trip",
      schema,
      prompt,
      requestedAt: new Date().toISOString(),
    });
  }

  let paused = false;

  try {
    paused = await db.transaction(async (tx: Db) => {
      const upd = await tx
        .update(runs)
        .set(
          runKind === "flow"
            ? { status: "NeedsInput", currentStepId: stepId }
            : { status: "NeedsInput" },
        )
        .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
        .returning({ id: runs.id });

      if (upd.length === 0) return false;

      if (attempt) {
        await markNodeNeedsInput(attempt.id, tx);
      }

      await tx.insert(hitlRequests).values({
        id: hitlRequestId,
        runId,
        stepId,
        kind: "hook_trip",
        schema,
        prompt,
      });

      // Project-less local-package runs never arm guardrails, but guard the
      // project-scoped emits/assignment defensively (mirrors the budget path).
      if (run.projectId) {
        if (assign) {
          await createHitlAssignmentForRun({
            db: tx,
            runId,
            hitlRequestId,
            nodeId: stepId,
            actionKind: "hook_trip",
            roleRefs: [],
            title: prompt,
          });
        }
        await emitWebhookEvent({
          db: tx,
          type: "run.needs_input",
          projectId: run.projectId,
          runId,
          data: { reason: "hook_trip", nodeId: stepId },
        });
        await emitDomainEvent({
          db: tx,
          kind: "run.escalated",
          projectId: run.projectId,
          runId,
          taskId: run.taskId,
          actor: { type: "system", id: null },
          payload: { runId, reason: "hook_trip", rule },
        });
        await emitWebhookEvent({
          db: tx,
          type: "run.escalated",
          projectId: run.projectId,
          runId,
          data: { reason: "hook_trip", rule },
        });
      }

      return true;
    });
  } catch (err) {
    if (needsInputPath) {
      await unlink(needsInputPath).catch(() => undefined);
    }
    throw err;
  }

  if (!paused) {
    log.debug(
      { runId },
      "[hook-trip] escalate CAS lost — run advanced concurrently",
    );

    return { escalated: false };
  }

  logExecPolicyAction({
    runId,
    kind: "escalated",
    detail: { reason: "hook_trip", rule, nodeId: stepId },
  });
  log.warn(
    { runId, rule, runKind, assign },
    "[hook-trip] escalated → NeedsInput (hook_trip HITL)",
  );

  return { escalated: true };
}
