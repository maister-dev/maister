import "server-only";

import type { NodeAttemptType } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq, gt } from "drizzle-orm";
import pino from "pino";

import { createHitlAssignmentForRun } from "@/lib/assignments/service";
import { atomicWriteJson } from "@/lib/atomic";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { markNodeNeedsInput } from "@/lib/flows/graph/ledger";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { runtimeRoot as configuredRuntimeRoot } from "@/lib/instance-config";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, nodeAttempts, projects, runs } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "node-interrupt",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-160: only agent-executed nodes can be interrupted. `cli` and `check` run
// a shell command in a detached process group; killing one mid-command is a
// different mechanism (and a different failure surface) and is deliberately out
// of v1 scope, so they are refused with a message that NAMES the deferral
// rather than failing obscurely.
export const INTERRUPTIBLE_NODE_TYPES: ReadonlySet<NodeAttemptType> = new Set([
  "ai_coding",
  "judge",
  "orchestrator",
] as NodeAttemptType[]);

// The four server-owned options, in presentation order. `restart_node` is the
// default: it is the one-click "you went off track, try that node again".
export const NODE_INTERRUPT_OPTION_IDS = [
  "resume",
  "restart_node",
  "restart_from",
  "stop",
] as const;

export type NodeInterruptOptionId = (typeof NODE_INTERRUPT_OPTION_IDS)[number];

export const WORKSPACE_POLICY_IDS = [
  "keep",
  "rewind-to-node-checkpoint",
  "fresh-attempt",
] as const;

export type NodeInterruptWorkspacePolicy =
  (typeof WORKSPACE_POLICY_IDS)[number];

export type NodeInterruptRestartTarget = {
  nodeId: string;
  // A declared rework target of the interrupted node. Presentation only — it
  // never widens or narrows what is permitted.
  recommended: boolean;
};

export type NodeInterruptOptionMatrix = {
  defaultOptionId: NodeInterruptOptionId;
  options: Array<{
    optionId: NodeInterruptOptionId;
    enabled: boolean;
    disabledReason: string | null;
  }>;
  // Ledger-derived: nodes with >= 1 prior attempt in THIS run.
  restartTargets: NodeInterruptRestartTarget[];
};

export type EscalateNodeInterruptArgs = {
  db?: Db;
  runId: string;
  actorUserId: string;
  supervisorSessionId: string;
  // Injected so the caller owns the supervisor api, mirroring escalateHookTrip.
  checkpointSession: (sessionId: string) => Promise<unknown>;
};

export type EscalateNodeInterruptResult = {
  hitlRequestId: string;
  nodeId: string;
};

type RunRow = {
  projectId: string | null;
  taskId: string | null;
  status: string;
  runKind: string;
  currentStepId: string | null;
  projectSlug: string | null;
};

async function loadRunRow(db: Db, runId: string): Promise<RunRow | null> {
  const rows = await db
    .select({
      projectId: runs.projectId,
      taskId: runs.taskId,
      status: runs.status,
      runKind: runs.runKind,
      currentStepId: runs.currentStepId,
      projectSlug: projects.slug,
    })
    .from(runs)
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId));

  return rows[0] ?? null;
}

async function fetchRunningAttempt(
  db: Db,
  runId: string,
): Promise<{ id: string; nodeId: string; nodeType: NodeAttemptType } | null> {
  const rows = await db
    .select({
      id: nodeAttempts.id,
      nodeId: nodeAttempts.nodeId,
      nodeType: nodeAttempts.nodeType,
    })
    .from(nodeAttempts)
    .where(
      and(eq(nodeAttempts.runId, runId), eq(nodeAttempts.status, "Running")),
    )
    .orderBy(asc(nodeAttempts.attempt));

  return rows.length > 0 ? rows[rows.length - 1] : null;
}

function interruptPrompt(nodeId: string): string {
  return `You interrupted "${nodeId}" mid-turn. Resume it as-is, restart it (optionally with a correction), restart from an earlier node, or stop the run.`;
}

function interruptSchema(nodeId: string): Record<string, unknown> {
  return {
    kind: "node_interrupt",
    nodeId,
    decisions: [...NODE_INTERRUPT_OPTION_IDS],
    workspacePolicies: [...WORKSPACE_POLICY_IDS],
  };
}

/**
 * ADR-160: pause ONE live agent node and park the run for a corrective restart.
 *
 * Mechanics are `escalateHookTrip`'s, reused rather than re-derived: checkpoint
 * BEFORE the transaction (an `EXECUTOR_UNAVAILABLE` checkpoint re-throws with no
 * mutation, so there is no split-brain), write `needs-input.json` before the
 * transaction and unlink it if the transaction throws, then perform the whole
 * park in ONE transaction.
 *
 * Every identifier is server-state: the node, its attempt, and the supervisor
 * session are all derived here, never taken from a request body.
 */
export async function escalateNodeInterrupt(
  args: EscalateNodeInterruptArgs,
): Promise<EscalateNodeInterruptResult> {
  const { runId, actorUserId, supervisorSessionId } = args;
  const db = args.db ?? getDb();
  const run = await loadRunRow(db, runId);

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }

  // Admission allow-list — a status not named here is refused by default.
  if (run.status !== "Running") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${runId} is not Running (got ${run.status}); nothing to interrupt`,
    );
  }
  if (run.runKind !== "flow") {
    throw new MaisterError(
      "PRECONDITION",
      `only flow runs have interruptible nodes (is ${run.runKind}) — an agent run carries no node_attempts; stop the run instead`,
    );
  }

  const attempt = await fetchRunningAttempt(db, runId);

  if (!attempt) {
    throw new MaisterError(
      "PRECONDITION",
      `run ${runId} has no node currently executing`,
    );
  }
  if (!INTERRUPTIBLE_NODE_TYPES.has(attempt.nodeType)) {
    throw new MaisterError(
      "PRECONDITION",
      `cannot interrupt a ${attempt.nodeType} node — only agent-executed nodes (ai_coding, judge, orchestrator) can be interrupted; interrupting a shell command mid-run is deferred, stop the run instead`,
    );
  }

  const nodeId = attempt.nodeId;

  log.debug(
    { runId, nodeId, nodeType: attempt.nodeType, nodeAttemptId: attempt.id },
    "[node-interrupt] admission passed",
  );

  // 1. Checkpoint pre-tx. EXECUTOR_UNAVAILABLE re-throws with NO mutation —
  // the run stays Running and the operator can retry. Any other failure means
  // the session is already gone; proceed to the pause.
  log.info(
    { runId, nodeId, sessionId: supervisorSessionId },
    "[node-interrupt] requesting checkpoint",
  );
  try {
    await args.checkpointSession(supervisorSessionId);
  } catch (err) {
    if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
      log.error(
        { runId, nodeId, err: err.message },
        "[node-interrupt] checkpoint undeliverable — re-throwing with no mutation",
      );

      throw err;
    }
    log.warn(
      { runId, nodeId, err: err instanceof Error ? err.message : String(err) },
      "[node-interrupt] checkpoint failed terminally — session already gone, proceeding to pause",
    );
  }

  const schema = interruptSchema(nodeId);
  const prompt = interruptPrompt(nodeId);
  const hitlRequestId = randomUUID();

  // 2. needs-input.json pre-tx, unlinked if the tx throws (CB1).
  const needsInputPath = run.projectSlug
    ? path.join(
        runDirPath(configuredRuntimeRoot(), run.projectSlug, runId),
        "needs-input.json",
      )
    : null;

  if (needsInputPath) {
    await atomicWriteJson(needsInputPath, {
      nodeId,
      kind: "node_interrupt",
      schema,
      prompt,
      requestedAt: new Date().toISOString(),
    });
  }

  let paused = false;

  try {
    // 3. ONE transaction: CAS + ledger + HITL + assignment + both emits.
    paused = await db.transaction(async (tx: Db) => {
      const upd = await tx
        .update(runs)
        .set({ status: "NeedsInput", currentStepId: nodeId })
        .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
        .returning({ id: runs.id });

      if (upd.length === 0) return false;

      await markNodeNeedsInput(attempt.id, tx);

      await tx.insert(hitlRequests).values({
        id: hitlRequestId,
        runId,
        stepId: nodeId,
        kind: "node_interrupt",
        schema,
        prompt,
      });

      if (run.projectId) {
        await createHitlAssignmentForRun({
          db: tx,
          runId,
          hitlRequestId,
          nodeId,
          actionKind: "node_interrupt",
          roleRefs: [],
          title: prompt,
        });
        await emitWebhookEvent({
          db: tx,
          type: "run.needs_input",
          projectId: run.projectId,
          runId,
          data: { reason: "node_interrupt", nodeId },
        });
        // Reuses the EXISTING run.escalated kind — an operator pausing a node is
        // an escalation like any other, which is why Feature B needs no taxonomy
        // entry and no CHECK migration (ADR-159's claim/return do).
        await emitDomainEvent({
          db: tx,
          kind: "run.escalated",
          projectId: run.projectId,
          runId,
          taskId: run.taskId,
          actor: { type: "user", id: actorUserId },
          payload: { runId, reason: "node_interrupt", nodeId },
        });
        await emitWebhookEvent({
          db: tx,
          type: "run.escalated",
          projectId: run.projectId,
          runId,
          data: { reason: "node_interrupt", nodeId },
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
    // CB1's sibling: the node finished first. No HITL row was inserted (the tx
    // rolled back at the CAS), so nothing is orphaned.
    if (needsInputPath) {
      await unlink(needsInputPath).catch(() => undefined);
    }
    log.warn(
      { runId, nodeId },
      "[node-interrupt] CAS lost — the node completed before the interrupt applied",
    );

    throw new MaisterError(
      "CONFLICT",
      `node ${nodeId} of run ${runId} completed before the interrupt was applied`,
    );
  }

  log.info(
    { runId, nodeId, nodeAttemptId: attempt.id, hitlRequestId },
    "[node-interrupt] parked",
  );

  return { hitlRequestId, nodeId };
}

/**
 * ADR-160: derive the server-owned option matrix for a parked `node_interrupt`.
 *
 * `restart_from`'s eligible targets are LEDGER-derived — the nodes with at
 * least one prior attempt in THIS run — because the static graph has cycles and
 * "earlier" is therefore not derivable from topology. A target outside that set
 * is refused: forward skips would bypass the artifacts those nodes produce.
 *
 * Pure and synchronous: the caller supplies the ledger rows and the interrupted
 * node's declared rework targets, so this is unit-testable without Postgres.
 */
export function deriveNodeInterruptOptions(args: {
  interruptedNodeId: string;
  // Every `node_attempts` row for this run, in ledger order.
  ledgerNodeIds: readonly string[];
  // The interrupted node's declared `rework.allowedTargets`, if any. Used ONLY
  // to flag a target as recommended — never to widen or narrow eligibility.
  declaredReworkTargets?: readonly string[];
  // Attempts already closed with `decision='operator_interrupt'` for this run.
  operatorRestartCount: number;
  maxOperatorRestarts: number;
}): NodeInterruptOptionMatrix {
  const declared = new Set(args.declaredReworkTargets ?? []);
  const seen = new Set<string>();
  const restartTargets: NodeInterruptRestartTarget[] = [];

  for (const nodeId of args.ledgerNodeIds) {
    if (nodeId === args.interruptedNodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    restartTargets.push({ nodeId, recommended: declared.has(nodeId) });
  }

  const capReached = args.operatorRestartCount >= args.maxOperatorRestarts;
  const capReason = capReached
    ? `this run has already used ${args.operatorRestartCount} operator restarts (MAISTER_MAX_OPERATOR_RESTARTS=${args.maxOperatorRestarts})`
    : null;

  return {
    defaultOptionId: "restart_node",
    options: [
      { optionId: "resume", enabled: true, disabledReason: null },
      {
        optionId: "restart_node",
        enabled: !capReached,
        disabledReason: capReason,
      },
      {
        optionId: "restart_from",
        enabled: !capReached && restartTargets.length > 0,
        disabledReason: capReached
          ? capReason
          : restartTargets.length === 0
            ? "no earlier node has run in this run yet"
            : null,
      },
      { optionId: "stop", enabled: true, disabledReason: null },
    ],
    restartTargets,
  };
}

// ADR-160 D6: the operator correction is length-capped before storage. It is
// appended verbatim inside a fence, never interpolated as a template.
export const OPERATOR_CORRECTION_MAX = 4000;

/**
 * ADR-160 D6: the operator correction owed to the NEXT attempt at `nodeId`.
 *
 * Consume-once without a mutable flag: a correction applies only while the
 * target node has exactly ONE attempt started after the response was recorded —
 * i.e. the restarted attempt itself. The attempt after that sees none, so the
 * correction cannot leak forward into an unrelated later visit.
 *
 * Returns null when there is nothing to append, which is the overwhelmingly
 * common path (every run that was never interrupted).
 */
export async function loadPendingOperatorCorrection(
  db: Db,
  runId: string,
  nodeId: string,
): Promise<string | null> {
  const answered = await db
    .select({
      respondedAt: hitlRequests.respondedAt,
      response: hitlRequests.response,
    })
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "node_interrupt"),
      ),
    );

  const candidates = answered
    .filter(
      (r: { respondedAt: Date | null; response: unknown }) =>
        r.respondedAt !== null &&
        typeof (r.response as { correction?: unknown } | null)?.correction ===
          "string" &&
        ((r.response as { targetNodeId?: unknown }).targetNodeId ?? null) ===
          nodeId,
    )
    .sort(
      (a: { respondedAt: Date }, b: { respondedAt: Date }) =>
        a.respondedAt.getTime() - b.respondedAt.getTime(),
    );

  if (candidates.length === 0) return null;

  const latest = candidates[candidates.length - 1];
  const since = latest.respondedAt as Date;

  const startedSince = await db
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        eq(nodeAttempts.nodeId, nodeId),
        gt(nodeAttempts.startedAt, since),
      ),
    );

  // >1 means a later attempt already ran past the restart — the correction was
  // consumed and must not be re-applied.
  if (startedSince.length !== 1) {
    log.debug(
      { runId, nodeId, attemptsSince: startedSince.length },
      "[node-interrupt] correction already consumed",
    );

    return null;
  }

  const correction = (latest.response as { correction: string }).correction;

  log.debug(
    { runId, nodeId, correctionChars: correction.length },
    "[node-interrupt] correction owed to this attempt",
  );

  return correction;
}
