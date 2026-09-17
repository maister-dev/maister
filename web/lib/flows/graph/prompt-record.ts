import "server-only";

import type { ContextMountSnapshot } from "@/lib/context-mounts/types";
import type { ConsensusPromptOwner } from "./consensus/prompt-owner";
import type { NodePromptOwner } from "./node-prompt-owner";
import type { GatePromptOwner } from "./prompt-owner";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { consensusPromptOperationKey } from "./consensus/prompt-owner";
import { nodePromptOperationKey } from "./node-prompt-owner";
import { gatePromptOperationKey } from "./prompt-owner";

import { executionEvents, runs } from "@/lib/db/schema";
import { appendRunMessage } from "@/lib/execution-host/events/run-message-store";

const log = pino({
  name: "flow-prompt-record",
  level: process.env.LOG_LEVEL ?? "info",
});

export type DispatchPromptOwner =
  | NodePromptOwner
  | GatePromptOwner
  | ConsensusPromptOwner;

/** TRC-09. A resolved prompt can inject artifact bodies through
 * `{{ artifacts.<id>.content }}` (ADR-120) and reach megabytes; storing that
 * unbounded would reintroduce the row bloat this work removes. */
export const PROMPT_BODY_MAX_BYTES = 256 * 1024;

export const PROMPT_TRUNCATION_MARKER =
  "\n\n[truncated at 256 KiB — the unabridged prompt for this attempt's" +
  " first dispatch is node_attempts.resolved_prompt]";

/**
 * The per-dispatch identity of a recorded prompt.
 *
 * D5: the command plane ALREADY defines canonical per-owner identity, and the
 * fence the rest of it uses is built from these same functions. A second
 * identity scheme would be a second thing to keep in step, so this is a total
 * switch that delegates — never a parallel string built here.
 */
export function promptDispatchKey(owner: DispatchPromptOwner): string {
  switch (owner.variant) {
    case "node":
    case "permission_resume":
      return `dispatch:${nodePromptOperationKey(owner)}`;
    case "gate_ai":
    case "gate_skill":
      return `dispatch:${gatePromptOperationKey(owner)}`;
    case "consensus_verifier":
    case "consensus_synthesis":
      return `dispatch:${consensusPromptOperationKey(owner)}`;
    default: {
      const unreachable: never = owner;

      throw new Error(
        `unhandled prompt owner variant: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/** TRC-09 / EDGE-TRC-05. The bound is in BYTES, so the cut is taken on a
 * character boundary — a split multi-byte sequence would otherwise store
 * replacement characters in place of the text it truncated. */
export function boundPromptBody(body: string): {
  content: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(body, "utf8") <= PROMPT_BODY_MAX_BYTES) {
    return { content: body, truncated: false };
  }
  const budget =
    PROMPT_BODY_MAX_BYTES - Buffer.byteLength(PROMPT_TRUNCATION_MARKER, "utf8");
  const head = new TextDecoder("utf-8")
    .decode(Buffer.from(body, "utf8").subarray(0, budget))
    // A cut inside a multi-byte sequence decodes to U+FFFD; drop the tail.
    .replace(/\uFFFD+$/, "");

  return { content: head + PROMPT_TRUNCATION_MARKER, truncated: true };
}

/**
 * EDGE-TRC-07 / D9. The host prepends its own grounding preamble
 * (`renderContextMountPreamble`) to the prompt AFTER this text is recorded.
 * Reproducing that block web-side would duplicate host logic across two
 * packages with no shared lib — the same drift trap as `mcpServerFromToolName`
 * — so the row NAMES what was mounted and never fabricates the wording.
 */
export function appendContextMountLine(
  body: string,
  mounts: readonly ContextMountSnapshot[] | null | undefined,
): string {
  if (!mounts || mounts.length === 0) return body;

  return `${body}\n\n[context repositories mounted read-only by the host: ${mounts
    .map((mount) => mount.slug)
    .join(", ")}]`;
}

// FIXME(any): dual drizzle-orm peer-dep variants (mirrors runner-agent.ts).
type DbClientLike = any;

/** EDGE-TRC-08. The run's last INGESTED event, independent of whether it has
 * been projected yet — that independence is the whole point. `-1` for a run
 * with no events keeps a first prompt ahead of event `0`. Only `accepted`
 * events count: a duplicate or skipped one never becomes a transcript row, so
 * anchoring past it would push the prompt beyond replies that follow. */
async function eventHorizon(db: DbClientLike, runId: string): Promise<string> {
  const [row] = await db
    .select({
      horizon: sql<string | null>`max(${executionEvents.runSequence})`,
    })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.runId, runId),
        eq(executionEvents.ingestDisposition, "accepted"),
      ),
    );

  return row?.horizon ?? "-1";
}

async function loadContextMounts(
  db: DbClientLike,
  runId: string,
): Promise<ContextMountSnapshot[] | null> {
  const [run] = await db
    .select({ contextMounts: runs.contextMounts })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  return run?.contextMounts ?? null;
}

/**
 * Record one dispatched prompt as a `user` transcript row (TRC-05).
 *
 * BEST-EFFORT (TRC-08): this is audit data about a paid agent turn, and a
 * failed write must cost the run nothing. The alternative — a transcript-row
 * problem taking down the dispatch it was only meant to describe — is strictly
 * worse than a missing row.
 *
 * "Never DELAYS dispatch" is not enforced here, and deliberately so: `db` is
 * the caller's driver-scoped handle from `flowDriverDatabase`, whose `query`
 * and `transaction` both run through `projectionTransaction` — a cumulative
 * deadline, server-side `statement_timeout`/`lock_timeout`, backend
 * cancellation and rollback, plus the driver's abort signal. Both the read
 * below and the transaction are therefore already bounded, and a second
 * local budget would be a duplicate clock that could only drift from it.
 * The invariant this function depends on: callers pass the driver handle.
 * A raw root-pool handle would take the same locks with no deadline.
 *
 * `contextMounts` is read from the run when omitted; pass it explicitly
 * (`null` for none) to skip that read.
 */
export async function recordDispatchedPrompt(input: {
  db: DbClientLike;
  runId: string;
  nodeAttemptId: string | null;
  stepId: string;
  owner?: DispatchPromptOwner;
  prompt: string;
  contextMounts?: readonly ContextMountSnapshot[] | null;
}): Promise<void> {
  try {
    const mounts =
      input.contextMounts === undefined
        ? await loadContextMounts(input.db, input.runId)
        : input.contextMounts;
    const bounded = boundPromptBody(
      appendContextMountLine(input.prompt, mounts),
    );
    const promptDispatchKeyValue = input.owner
      ? promptDispatchKey(input.owner)
      : null;

    // EDGE-TRC-08. Anchor this row in the run's EVENT stream, not in the order
    // the two writers happened to arrive.
    //
    // `sequence` is an arrival counter shared by two writers on different
    // clocks: a prompt is written eagerly at dispatch, while replies are
    // projected by the canonical worker or lazily on read — the graph runner
    // drives only the ARTIFACT projector at its sync points, never this one.
    // The gap between a node's turn ending and its gate dispatching is a few
    // milliseconds, so the reply is normally still unprojected and a node with
    // a blocking gate would read `node prompt, gate prompt, node reply, gate
    // reply` for good. Ordering must therefore be a property of the DATA.
    //
    // The horizon is the run's last ingested event, which is exactly what the
    // transcript projector stores in the same column for its own rows
    // (`supervisorEventId = event.runSequence`), so both writers land on ONE
    // axis. `-1` when the run has no events yet keeps a first prompt ahead of
    // event 0. Readers break an exact tie with the dispatch key, since a
    // prompt issued AFTER event E sorts after the reply projected FROM E.
    const anchor = await eventHorizon(input.db, input.runId);
    const result = await input.db.transaction(
      (tx: Parameters<typeof appendRunMessage>[0]) =>
        appendRunMessage(tx, {
          runId: input.runId,
          nodeAttemptId: input.nodeAttemptId,
          role: "user",
          content: bounded.content,
          promptDispatchKey: promptDispatchKeyValue,
          supervisorEventId: anchor,
        }),
    );

    log.debug(
      {
        runId: input.runId,
        stepId: input.stepId,
        ownerVariant: input.owner?.variant ?? null,
        promptLen: input.prompt.length,
        truncated: bounded.truncated,
        sequence: result.sequence,
        recorded: result.inserted,
      },
      "dispatched prompt recorded",
    );
  } catch (err) {
    log.warn(
      {
        runId: input.runId,
        stepId: input.stepId,
        ownerVariant: input.owner?.variant ?? null,
        err: (err as Error).message,
      },
      "[prompt-record] dispatched prompt was not recorded",
    );
  }
}
