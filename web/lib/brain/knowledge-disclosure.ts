import "server-only";

import type {
  KnowledgeAccessCapture,
  KnowledgeAccessRestriction,
  Owner,
} from "@/lib/company/types";
import type { KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeTransaction } from "./knowledge-access";

import { sql } from "drizzle-orm";
import pino from "pino";

import { knowledgeWriteLockSql } from "./knowledge-write-lock";

import {
  knowledgeAccessCaptureSchema,
  knowledgeRestrictionsSchema,
} from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { pgErrorOf } from "@/lib/db/pg-error";
import { parseBoundRunId } from "@/lib/tokens/verify";

const log = pino({
  name: "brain:knowledge-disclosure",
  level: process.env.LOG_LEVEL ?? "info",
});

export type KnowledgeReadConsumer = Readonly<{
  runId: string;
  capture: KnowledgeAccessCapture;
}> | null;

export function canonicalKnowledgeRestrictions(
  restrictions: readonly KnowledgeAccessRestriction[],
): KnowledgeAccessRestriction[] {
  const entries = new Map(
    restrictions.map((entry) => [contentDigest(entry), entry]),
  );

  return [...entries.keys()].sort().map((key) => entries.get(key)!);
}

/** Destination ownership already supplies its own read gate; narrower record/source dependencies remain. */
export function additionalKnowledgeRestrictions(
  owner: Owner,
  restrictions: readonly KnowledgeAccessRestriction[],
): KnowledgeAccessRestriction[] {
  const destination = contentDigest(owner);

  const retained = canonicalKnowledgeRestrictions(
    restrictions.filter(
      (restriction) => contentDigest(restriction) !== destination,
    ),
  );

  if (
    !knowledgeRestrictionsSchema.safeParse(retained).success ||
    Buffer.byteLength(JSON.stringify(retained), "utf8") > 65536
  )
    throw new MaisterError(
      "PRECONDITION",
      "Inherited knowledge source access exceeds its bounded contract",
      { details: { reason: "knowledge_capture_limit" } },
    );

  return retained;
}

/** Lock the consumer before record/grant reads; concurrent tools cannot upgrade shared run locks. */
export async function lockKnowledgeReadConsumer(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
): Promise<KnowledgeReadConsumer> {
  if (principal.kind === "user") return null;
  const token = (
    await tx.execute(
      sql`SELECT name,token_kind FROM project_tokens WHERE id=${principal.tokenId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) FOR SHARE`,
    )
  ).rows[0];

  if (!token)
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current native knowledge token is required",
    );
  if (token.token_kind === "user") return null;
  if (
    token.token_kind !== "agent" &&
    !(
      token.token_kind === "project" &&
      String(token.name).startsWith("orchestrator-run:")
    )
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "This token cannot consume shared native knowledge",
    );
  const runId = parseBoundRunId(String(token.name));
  const run =
    runId === null
      ? undefined
      : (
          await tx.execute(
            sql`SELECT knowledge_access FROM runs WHERE id=${runId} AND status IN ('Pending','Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','Review') FOR UPDATE`,
          )
        ).rows[0];
  const capture = knowledgeAccessCaptureSchema.safeParse(run?.knowledge_access);

  if (
    runId === null ||
    !run ||
    !capture.success ||
    capture.data.state !== "complete"
  )
    throw new MaisterError(
      "PRECONDITION",
      "Native knowledge requires a compatible server-owned source capture profile",
      { details: { reason: "knowledge_capture_profile_required" } },
    );

  return { runId, capture: capture.data };
}

/** Cross-owner source graphs can cycle. Serialize bounded native writes before taking any record locks. */
export async function lockKnowledgeWriteConsumer(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
): Promise<KnowledgeReadConsumer> {
  const consumer = await lockKnowledgeReadConsumer(tx, principal);

  try {
    await tx.execute(sql`SELECT ${knowledgeWriteLockSql()}`);
  } catch (error) {
    if (pgErrorOf(error)?.code === "55P03") {
      log.warn(
        {
          principalKind: principal.kind,
          runId: consumer?.runId,
          reason: "knowledge_write_busy",
        },
        "native knowledge write admission exhausted its lock bound",
      );
      throw new MaisterError(
        "CONFLICT",
        "Another knowledge update is in progress; retry the same delivery after inspecting current state",
        { details: { reason: "knowledge_write_busy" } },
      );
    }
    throw error;
  }
  log.debug(
    { principalKind: principal.kind, runId: consumer?.runId },
    "native knowledge write admitted before source record locks",
  );

  return consumer;
}

/** Disclosure commits its complete restriction union before any bytes leave the service. */
export async function recordKnowledgeDisclosure(
  tx: KnowledgeTransaction,
  consumer: KnowledgeReadConsumer,
  restrictions: readonly KnowledgeAccessRestriction[],
): Promise<void> {
  if (consumer === null) return;
  const combined = canonicalKnowledgeRestrictions([
    ...consumer.capture.restrictions,
    ...restrictions,
  ]);

  if (
    !knowledgeRestrictionsSchema.safeParse(combined).success ||
    Buffer.byteLength(JSON.stringify(combined), "utf8") > 65536
  )
    throw new MaisterError(
      "PRECONDITION",
      "Native knowledge source capture reached its bound; narrow the requested work",
      { details: { reason: "knowledge_capture_limit" } },
    );
  if (contentDigest(combined) === contentDigest(consumer.capture.restrictions))
    return;
  if (consumer.capture.generation === 2147483647)
    throw new MaisterError(
      "PRECONDITION",
      "Native knowledge capture generation is exhausted",
    );
  const capture: KnowledgeAccessCapture = {
    ...consumer.capture,
    generation: consumer.capture.generation + 1,
    restrictions: combined,
  };

  await tx.execute(
    sql`UPDATE runs SET knowledge_access=${JSON.stringify(capture)}::jsonb WHERE id=${consumer.runId}`,
  );
}
