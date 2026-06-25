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

const { scratchMessages } = schema as unknown as Record<string, any>;

export async function postProcessFlowAssistantTurn(args: {
  db: Db;
  localPackage: LocalPackage;
  runId: string;
  assertCanApply: () => Promise<void>;
}): Promise<FlowActionResultPayload | null> {
  const latest = await loadLatestAssistantMessage(args.db, args.runId);

  if (!latest) return null;

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

  if (parsed.kind === "none") return null;

  await updateAssistantMessage({
    db: args.db,
    messageId: latest.id,
    content: visibleAssistantText(parsed.sanitizedText, parsed.kind),
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

  const applyResult = await validateAndApplyFlowAssistantAction({
    localPackage: args.localPackage,
    runId: args.runId,
    action: parsed.action,
    assertCanApply: args.assertCanApply,
  });

  await insertActionResultMessage({
    db: args.db,
    runId: args.runId,
    result: applyResult.result,
  });

  return applyResult.result;
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
