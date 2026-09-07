import "server-only";

import type { LocalPackage } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { validateAndApplyFlowAssistantAction } from "./apply";
import {
  createMalformedActionResult,
  encodeFlowActionResultPayload,
  parseAssistantActionBlocks,
  type FlowActionResultPayload,
} from "./protocol";

import * as schema from "@/lib/db/schema";
import { nextScratchMessageSequence } from "@/lib/scratch-runs/messages";

type Db = any;

const log = pino({
  name: "studio/flow-assistant/turn",
  level: process.env.LOG_LEVEL ?? "info",
});

const { flowAssistantActions, scratchMessages } = schema as unknown as Record<
  string,
  any
>;

export async function postProcessFlowAssistantTurn(args: {
  db: Db;
  localPackage: LocalPackage;
  runId: string;
  lockGeneration: string;
  assertCanApply: () => Promise<void>;
}): Promise<FlowActionResultPayload | null> {
  // A pending action from an earlier, interrupted turn is settled before this
  // turn's own message is read: extraction sanitizes the message, so without
  // durable intent that action would be lost rather than replayed.
  const recovered = await settlePendingFlowAssistantActions(args);
  const latest = await loadLatestAssistantMessage(args.db, args.runId);

  if (!latest) return recovered;

  log.debug(
    {
      localPackageId: args.localPackage.id,
      runId: args.runId,
      messageId: latest.id,
      byteLength: Buffer.byteLength(latest.content, "utf8"),
    },
    "flow assistant parse attempt",
  );

  const parsed = parseAssistantActionBlocks(latest.content);

  if (parsed.kind === "none") return recovered;

  // Sanitizing the message consumes the action. Retain it in the same
  // transaction so a crash before the package apply keeps a recoverable intent.
  await args.db.transaction(async (tx: Db) => {
    await updateAssistantMessage({
      db: tx,
      messageId: latest.id,
      content: visibleAssistantText(parsed.sanitizedText, parsed.kind),
    });
    if (parsed.kind === "parsed")
      await tx
        .insert(flowAssistantActions)
        .values({
          id: randomUUID(),
          runId: args.runId,
          localPackageId: args.localPackage.id,
          lockGeneration: args.lockGeneration,
          messageId: latest.id,
          action: parsed.action,
        })
        .onConflictDoNothing({ target: flowAssistantActions.messageId });
  });

  if (parsed.kind === "malformed") {
    const result = createMalformedActionResult({
      issues: parsed.issueSummary,
    });

    await insertActionResultMessage({
      db: args.db,
      runId: args.runId,
      result,
    });
    log.warn(
      {
        localPackageId: args.localPackage.id,
        runId: args.runId,
        issueCount: result.issueCount,
      },
      "flow assistant malformed action hidden",
    );

    return result;
  }

  log.info(
    {
      localPackageId: args.localPackage.id,
      runId: args.runId,
      actionId: parsed.action.actionId,
      operationCount: parsed.action.operations.length,
    },
    "flow assistant action extracted",
  );

  const [intent] = await args.db
    .select()
    .from(flowAssistantActions)
    .where(eq(flowAssistantActions.messageId, latest.id));

  return applyJournalledAction({ ...args, intent });
}

/** Apply one retained intent and settle it forward exactly once. */
async function applyJournalledAction(args: {
  db: Db;
  localPackage: LocalPackage;
  runId: string;
  assertCanApply: () => Promise<void>;
  intent: {
    id: string;
    state: string;
    action: Record<string, unknown>;
  };
}): Promise<FlowActionResultPayload | null> {
  if (args.intent.state !== "pending") return null;
  const applyResult = await validateAndApplyFlowAssistantAction({
    localPackage: args.localPackage,
    runId: args.runId,
    action: args.intent.action as never,
    assertCanApply: args.assertCanApply,
  });
  const settled = await settleAction({
    db: args.db,
    id: args.intent.id,
    state: applyResult.ok ? "applied" : "rejected",
    result: applyResult.result,
  });

  if (!settled) return null;
  await insertActionResultMessage({
    db: args.db,
    runId: args.runId,
    result: applyResult.result,
  });

  return applyResult.result;
}

/** CAS out of `pending`; a competing settlement wins and this caller yields. */
async function settleAction(args: {
  db: Db;
  id: string;
  state: "applied" | "rejected" | "skipped";
  result?: FlowActionResultPayload;
}): Promise<boolean> {
  const rows = await args.db
    .update(flowAssistantActions)
    .set({
      state: args.state,
      completedAt: new Date(),
      ...(args.result ? { result: args.result } : {}),
    })
    .where(
      and(
        eq(flowAssistantActions.id, args.id),
        eq(flowAssistantActions.state, "pending"),
      ),
    )
    .returning({ id: flowAssistantActions.id });

  return rows.length > 0;
}

/** An action authorized by a lock generation that no longer holds is settled
 * `skipped`; the package is never edited by a superseded editor session. */
export async function settlePendingFlowAssistantActions(args: {
  db: Db;
  localPackage: LocalPackage;
  runId: string;
  lockGeneration: string;
  assertCanApply: () => Promise<void>;
}): Promise<FlowActionResultPayload | null> {
  const pending: Array<{
    id: string;
    state: string;
    lockGeneration: string;
    action: Record<string, unknown>;
  }> = await args.db
    .select()
    .from(flowAssistantActions)
    .where(
      and(
        eq(flowAssistantActions.runId, args.runId),
        eq(flowAssistantActions.state, "pending"),
      ),
    );
  let last: FlowActionResultPayload | null = null;

  for (const intent of pending) {
    if (intent.lockGeneration !== args.lockGeneration) {
      await settleAction({ db: args.db, id: intent.id, state: "skipped" });
      log.warn(
        {
          localPackageId: args.localPackage.id,
          runId: args.runId,
          actionId: intent.id,
        },
        "flow assistant action skipped by a newer lock generation",
      );
      continue;
    }
    last = (await applyJournalledAction({ ...args, intent })) ?? last;
  }

  return last;
}

async function loadLatestAssistantMessage(
  db: Db,
  runId: string,
): Promise<{ id: string; content: string } | null> {
  const rows: Array<{ id: string; content: string }> = await db
    .select({ id: scratchMessages.id, content: scratchMessages.content })
    .from(scratchMessages)
    .where(
      and(
        eq(scratchMessages.runId, runId),
        eq(scratchMessages.role, "assistant"),
      ),
    )
    .orderBy(desc(scratchMessages.sequence))
    .limit(1);

  return rows[0] ?? null;
}

async function updateAssistantMessage(args: {
  db: Db;
  messageId: string;
  content: string;
}): Promise<void> {
  await args.db
    .update(scratchMessages)
    .set({ content: args.content })
    .where(eq(scratchMessages.id, args.messageId));
}

async function insertActionResultMessage(args: {
  db: Db;
  runId: string;
  result: FlowActionResultPayload;
}): Promise<void> {
  const sequenceRows: Array<{ sequence: number }> = await args.db
    .select({ sequence: scratchMessages.sequence })
    .from(scratchMessages)
    .where(eq(scratchMessages.runId, args.runId));
  const sequence = nextScratchMessageSequence(
    sequenceRows.map((row) => row.sequence),
  );

  await args.db.insert(scratchMessages).values({
    id: randomUUID(),
    runId: args.runId,
    sequence,
    role: "system",
    content: encodeFlowActionResultPayload(args.result),
    supervisorEventId: null,
    createdAt: new Date(),
  });
}

function visibleAssistantText(
  text: string,
  kind: "parsed" | "malformed",
): string {
  if (text.trim()) return text.trim();

  return kind === "parsed"
    ? "I prepared a Flow update for MAIster to validate."
    : "I prepared an action, but MAIster could not read it.";
}
